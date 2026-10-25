<template>
    <div class="app">
        <nav class="sidebar">
            <div class="logo">
                <img class="logo-icon" :src="logoUrl" alt="" aria-hidden="true" />
                <h1>Waxwing</h1>
            </div>
            <router-link to="/" class="nav-item" :class="{ active: $route.path === '/' }">
                <span class="nav-icon">📋</span>
                任务
            </router-link>
            <router-link to="/providers" class="nav-item" :class="{ active: $route.path === '/providers' }">
                <span class="nav-icon">🔧</span>
                服务商
            </router-link>
            <router-link to="/settings" class="nav-item" :class="{ active: $route.path === '/settings' }">
                <span class="nav-icon">⚙️</span>
                设置
            </router-link>
        </nav>
        <main class="content">
            <router-view />
        </main>
    </div>
</template>

<script setup lang="ts">
import logoUrl from './assets/waxwing-mark.svg'
</script>

<style scoped>
.app {
    display: flex;
    width: 100%;
    height: 100vh;
}

.sidebar {
    width: 200px;
    background: linear-gradient(180deg, #ffeef3 0%, #ffe0ea 100%);
    padding: 24px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border-right: 1px solid #f8cdd8;
}

.logo {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 32px;
    padding: 0 8px;
}

.logo-icon {
    width: 28px;
    height: 28px;
    border-radius: 9px;
    box-shadow: 0 3px 10px rgba(191, 31, 91, 0.22);
}

.sidebar h1 {
    font-size: 20px;
    color: #e91e63;
    font-weight: 600;
}

.nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-radius: 12px;
    color: #9a7b8a;
    text-decoration: none;
    transition: all 0.2s;
    font-size: 14px;
}

.nav-item:hover {
    background: rgba(255, 255, 255, 0.6);
    color: #e91e63;
}

.nav-item.active {
    background: linear-gradient(135deg, #f8bbd0 0%, #f48fb1 100%);
    color: #fff;
    box-shadow: 0 2px 8px rgba(244, 143, 177, 0.3);
}

.nav-icon {
    font-size: 16px;
}

.content {
    flex: 1;
    padding: 28px;
    overflow-y: auto;
    background: #fff5f7;
}
</style>
