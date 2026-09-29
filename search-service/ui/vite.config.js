import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        port: 5180,
        proxy: {
            '/api': {
                target: 'http://localhost:8000',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
            },
        },
    },
});
