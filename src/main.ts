// Точка входа: поднимаем приложение и запускаем цикл рендеринга.
import { createDioramaApp } from './app.ts';

declare global {
    interface Window {
        __app?: any;
    }
}

const app = await createDioramaApp();
window.__app = app;
app.start();

