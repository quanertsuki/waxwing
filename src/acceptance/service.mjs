import fs from 'node:fs';
import path from 'node:path';

export function reportContent(task, {policySection = ''} = {}) {
  return `# Waxwing task ${task.id}\n\nWorkspace: ${task.workspace}\nSource workspace: ${task.sourceWorkspace ?? task.workspace}\nModel: ${task.model}\nPlan: ${task.plan}\nAcceptance criteria: ${task.criteria}\n\n` +
    task.rounds.map(round => `## Round ${round.number}\n\nRound ID: ${round.roundId ?? '(legacy)'}\n\nOutput budget: ${round.maxTokens ?? '(inherited from the task default)'}\n\nReasoning effort: ${round.effort ?? '(not applied)'}\n\nInstruction:\n${round.prompt}\n\nResult:\n${round.result?.text ?? '(interrupted)'}\n\nEnd: ${round.result?.finishReason ?? round.result?.error ?? 'interrupted'}\n`).join('\n') +
    `\n## Delegating acceptance\n\n${task.acceptance?.evidence ?? '(not accepted)'}\n\nAccepted at: ${task.acceptance?.at ?? '-'}\n` +
    policySection;
}

export function writeTaskReport(task, {reportsDir, digest, policySection = ''}) {
  const content = reportContent(task, {policySection});
  const file = path.join(reportsDir, `${task.id}.md`);
  fs.writeFileSync(file, content);
  return {file, hash: digest(content)};
}

export function previewTaskDeletion(task, {directory, reportsDir, digest, live}) {
  if (task.status !== 'closed' || live) throw new Error('Close task and confirm runtime exit first');
  const file = path.join(reportsDir, `${task.id}.md`);
  if (!task.reportHash || !fs.existsSync(file) || digest(fs.readFileSync(file, 'utf8')) !== task.reportHash) {
    throw new Error('Complete archived report required before deletion');
  }
  const manifest = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const nestedPath = path.join(current, entry.name);
      const stat = fs.lstatSync(nestedPath);
      if (stat.isSymbolicLink()) {
        manifest.push({
          path: path.relative(directory, nestedPath),
          type: 'link',
          target: fs.readlinkSync(nestedPath),
          bytes: 0,
        });
        continue;
      }
      if (fs.realpathSync(nestedPath) !== nestedPath) {
        throw new Error('Unexpected redirected path during cleanup');
      }
      if (stat.isDirectory()) walk(nestedPath);
      else manifest.push({path: path.relative(directory, nestedPath), bytes: stat.size});
    }
  };
  walk(directory);
  return {
    id: task.id,
    directory,
    files: manifest.length,
    bytes: manifest.reduce((total, entry) => total + entry.bytes, 0),
    preserved: [file, task.workspace, ...(task.workspaceLease?.branch ? [task.workspaceLease.branch] : [])],
    fingerprint: digest(JSON.stringify(manifest)),
  };
}
