import { startServer } from './controller';
import { loadConfig } from './lib/config';

let config;
try {
    config = loadConfig();
} catch (e: any) {
    console.error(`Configuration error: ${e.message}\nSee .env.example and README.md.`);
    process.exit(1);
}
startServer(config);
