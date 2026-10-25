import { createRouter, createWebHistory } from 'vue-router';
import Tasks from './views/Tasks.vue';
import Providers from './views/Providers.vue';
import Settings from './views/Settings.vue';

const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', component: Tasks },
        { path: '/providers', component: Providers },
        { path: '/settings', component: Settings }
    ]
});

export default router;
