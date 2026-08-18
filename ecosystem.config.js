module.exports = {
    apps: [{
        name: 'whatsapp-bot',
        script: 'npx',
        args: 'tsx src/index.ts',
        cwd: './artifacts/api-server',
        env: {
            PORT: 8080,
            DATABASE_URL: 'postgresql://postgres:admin@localhost:5432/whatsapp_bot',
            NODE_ENV: 'development',
            SESSION_SECRET: 'mySuperSecretRandomString12345!'
        },
        interpreter: 'cmd.exe',
        interpreter_args: '/c'
    }]
};