import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AcceptanceService,
  CONFIRM_ERROR,
  GRANT_ERROR,
  GRANT_SCOPE,
  isValidGrant,
  previewTaskDeletion,
  sha256,
  writeTaskReport,
} from '../../src/acceptance/service.mjs';

const ID = 'task-0123456789ab';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waxwing-acceptance-'));
  const scratch = path.join(root, 'runs', ID);
  const reports = path.join(root, 'reports');
  const grants = path.join(root, 'runtime');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(scratch, {recursive: true});
  fs.mkdirSync(reports, {recursive: true});
  fs.mkdirSync(grants, {recursive: true});
  fs.mkdirSync(workspace, {recursive: true});
  fs.writeFileSync(path.join(scratch, 'record.json'), '{"ok":true}\n');
  fs.writeFileSync(path.join(scratch, 'nested.txt'), 'nested\n');
  const task = {
    id: ID,
    status: 'closed',
    workspace,
    sourceWorkspace: workspace,
    model: 'fixture-model',
    plan: 'plan',
    criteria: 'criteria',
    rounds: [{
      number: 1,
      roundId: 'round-1',
      prompt: 'do work',
      result: {text: 'done', finishReason: 'completed'},
    }],
    acceptance: null,
    workspaceLease: {mode: 'worktree', branch: `waxwing/${ID}`, status: 'retained'},
  };
  const service = new AcceptanceService({
    reportsDir: reports,
    grantsDir: grants,
    now: () => '2026-10-28T10:00:00.000Z',
  });
  return {root, scratch, reports, grants, workspace, task, service};
}

function closeFixture(context) {
  fs.rmSync(context.root, {recursive: true, force: true});
}

function closedTask(context) {
  const accepted = context.service.accept(
    {...context.task, status: 'awaiting_review'},
    {evidence: 'delegating checks passed'},
  );
  return {...accepted.task, status: 'closed'};
}

test('deletion preview requires closed status, confirmed exit, and the archived report hash', () => {
  const context = fixture();
  try {
    const open = closedTask(context);
    assert.throws(
      () => context.service.preview({...open, status: 'running'}, {directory: context.scratch}),
      /Close task and confirm runtime exit/,
    );
    assert.throws(
      () => context.service.preview(open, {directory: context.scratch, live: true}),
      /Close task and confirm runtime exit/,
    );
    assert.throws(
      () => context.service.preview({...open, reportHash: null}, {directory: context.scratch}),
      /Complete archived report/,
    );
    fs.appendFileSync(context.service.reportPath(ID), 'tampered\n');
    assert.throws(
      () => context.service.preview(open, {directory: context.scratch}),
      /Complete archived report/,
    );
  } finally {
    closeFixture(context);
  }
});

test('a changed scratch manifest invalidates a previously persisted grant', () => {
  const context = fixture();
  try {
    const task = closedTask(context);
    const preview = context.service.grant(task, {
      directory: context.scratch,
      confirmation: ID,
    });
    assert.equal(fs.existsSync(context.service.grantPath(ID)), true);
    assert.equal(context.service.hasGrant(ID), true);
    assert.equal(preview.id, ID);

    fs.writeFileSync(path.join(context.scratch, 'new.txt'), 'changed after preview\n');
    assert.throws(
      () => context.service.authorize(task, {directory: context.scratch}),
      new RegExp(GRANT_ERROR),
    );
    assert.equal(fs.existsSync(context.scratch), true);
  } finally {
    closeFixture(context);
  }
});

test('forged grants, wrong confirmations, and stale scopes never authorize deletion', () => {
  const context = fixture();
  try {
    const task = closedTask(context);
    assert.throws(
      () => context.service.grant(task, {directory: context.scratch, confirmation: 'task-wrong'}),
      new RegExp(CONFIRM_ERROR),
    );
    assert.equal(isValidGrant(ID, {
      id: ID,
      fingerprint: 'fingerprint',
      scope: 'another-task',
      at: '2026-10-28T10:00:00.000Z',
    }), false);
    assert.equal(isValidGrant('task-bbbbbbbbbbbb', {
      id: ID,
      fingerprint: 'fingerprint',
      scope: GRANT_SCOPE,
      at: '2026-10-28T10:00:00.000Z',
    }), false);

    fs.writeFileSync(context.service.grantPath(ID), JSON.stringify({
      id: ID,
      fingerprint: 'forged',
      scope: 'another-task',
      at: '2026-10-28T10:00:00.000Z',
    }));
    assert.equal(context.service.restoreGrant(ID), null);
    assert.throws(
      () => context.service.removeTask(task, {directory: context.scratch}),
      new RegExp(GRANT_ERROR),
    );
    assert.equal(fs.existsSync(context.scratch), true);
  } finally {
    closeFixture(context);
  }
});

test('successful deletion removes only scratch and retains the report, workspace, and branch', () => {
  const context = fixture();
  try {
    const task = closedTask(context);
    const report = context.service.reportPath(ID);
    context.service.grant(task, {directory: context.scratch, confirmation: ID});
    const result = context.service.removeTask(task, {directory: context.scratch});

    assert.equal(result.deleted, ID);
    assert.equal(fs.existsSync(context.scratch), false);
    assert.equal(fs.existsSync(report), true);
    assert.equal(fs.existsSync(context.workspace), true);
    assert.deepEqual(result.preserved, [report, context.workspace, `waxwing/${ID}`]);
    assert.equal(context.service.hasGrant(ID), false);
    assert.equal(fs.existsSync(context.service.grantPath(ID)), false);
  } finally {
    closeFixture(context);
  }
});

test('rework revocation clears acceptance, report hash, and the persisted grant', () => {
  const context = fixture();
  try {
    const accepted = context.service.accept(
      {...context.task, status: 'awaiting_review'},
      {evidence: 'reviewed'},
    );
    const closed = {...accepted.task, status: 'closed'};
    context.service.grant(closed, {directory: context.scratch, confirmation: ID});
    assert.equal(context.service.hasGrant(ID), true);

    const revoked = context.service.revoke({...accepted.task, reportHash: accepted.hash});
    assert.equal(revoked.acceptance, null);
    assert.equal(revoked.reportHash, null);
    assert.equal(context.service.hasGrant(ID), false);
    assert.equal(fs.existsSync(context.service.grantPath(ID)), false);
  } finally {
    closeFixture(context);
  }
});

test('compatibility report helpers keep the same hash and scratch safety checks', () => {
  const context = fixture();
  try {
    const {file, hash} = writeTaskReport(context.task, {reportsDir: context.reports});
    assert.equal(file, context.service.reportPath(ID));
    assert.equal(hash, sha256(fs.readFileSync(file, 'utf8')));
    assert.throws(
      () => previewTaskDeletion(
        {...context.task, status: 'closed', reportHash: hash},
        {directory: context.workspace, reportsDir: context.reports},
      ),
      /not the task scratch directory/,
    );
    assert.throws(
      () => previewTaskDeletion(
        {
          ...context.task,
          status: 'closed',
          reportHash: hash,
          workspace: path.join(context.scratch, 'nested'),
        },
        {directory: context.scratch, reportsDir: context.reports},
      ),
      /preserved path is inside the task scratch directory/,
    );
  } finally {
    closeFixture(context);
  }
});

test('accept, export, and delete sequence report persistence through save adapters', () => {
  const context = fixture();
  try {
    const saved = [];
    const accepted = context.service.acceptAndSave(
      {...context.task, status: 'awaiting_review'},
      {evidence: 'saved evidence', save: task => {
        saved.push(task);
        return task;
      }},
    );
    assert.equal(accepted.acceptance.evidence, 'saved evidence');
    assert.equal(accepted.reportHash, sha256(fs.readFileSync(context.service.reportPath(ID), 'utf8')));
    assert.equal(saved.length, 1);

    const exported = context.service.exportAndSave(
      {...accepted, status: 'closed'},
      {save: task => saved.push(task)},
    );
    assert.equal(exported.file, context.service.reportPath(ID));
    assert.equal(exported.hash, saved.at(-1).reportHash);

    context.service.grant({...accepted, status: 'closed'}, {
      directory: context.scratch,
      confirmation: ID,
    });
    const forgotten = [];
    const deleted = context.service.removeTaskAndForget(
      {...accepted, status: 'closed'},
      {directory: context.scratch, forget: id => forgotten.push(id)},
    );
    assert.equal(deleted.deleted, ID);
    assert.deepEqual(forgotten, [ID]);
    assert.equal(fs.existsSync(context.scratch), false);

    assert.throws(
      () => context.service.acceptAndSave(context.task, {evidence: 'x'}),
      /save dependency/,
    );
    assert.throws(
      () => context.service.exportAndSave(context.task, {}),
      /save dependency/,
    );
  } finally {
    closeFixture(context);
  }
});
