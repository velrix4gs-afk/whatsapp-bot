const { spawn } = require('child_process');

const child = spawn('cmd.exe', ['/c', 'C:\\Users\\NOVA-JINX\\Documents\\git folders\\whatsapp-bot\\start-bot.bat'], {
    stdio: 'inherit',
    shell: false,
});

child.on('exit', (code) => {
    console.log(`Bot exited with code ${code}`);
    process.exit(code || 0);
});

process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());