// 应用入口：装配 petite-vue 根 scope 并挂载。
// init() 经 @vue:mounted 触发，确保 this 为响应式代理。
import { createApp } from './vendor/petite-vue.es.js';
import { createStore } from './store.js';

createApp(createStore()).mount('#app');
