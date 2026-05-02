import { config } from 'dotenv';

config();

export const ENV = {
    FREE_RAM_THRESHOLD_MB: Number(process.env.FREE_RAM_THRESHOLD_MB) || 512,
    FREE_CPU_THRESHOLD_PERCENT: Number(process.env.FREE_CPU_THRESHOLD_PERCENT) || 85,
}