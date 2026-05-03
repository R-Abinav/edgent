import { config } from 'dotenv';

config();

export const ENV = {
  // Resource thresholds
  FREE_RAM_THRESHOLD_MB: Number(process.env.FREE_RAM_THRESHOLD_MB) || 512,
  FREE_CPU_THRESHOLD_PERCENT: Number(process.env.FREE_CPU_THRESHOLD_PERCENT) || 85,

  // Node role
  ROLE: (process.env.ROLE as 'provider' | 'requester') || 'provider',

  // AXL
  AXL_CONFIG_PATH: process.env.AXL_CONFIG_PATH || './node-config-a.json',
  AXL_API_PORT: Number(process.env.AXL_API_PORT) || 9002,

  // Edgent daemon
  DAEMON_PORT: Number(process.env.DAEMON_PORT) || 3001,

  // Ollama
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || 'tinyllama',

  // Wallet
  DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY || '',
  DEPLOYER_WALLET_ADDRESS: process.env.DEPLOYER_WALLET_ADDRESS || '',
  REQUESTER_WALLET_ADDRESS: process.env.REQUESTER_WALLET_ADDRESS || '',
  PROVIDER_WALLET_ADDRESS: process.env.PROVIDER_WALLET_ADDRESS || '',

  // Escrow contract (deployed on Base Sepolia)
  ESCROW_CONTRACT_ADDRESS: process.env.ESCROW_CONTRACT_ADDR || '',

  // KeeperHub
  KEEPERHUB_API_KEY: process.env.KEEPERHUB_API_KEY || '',
  KEEPERHUB_BASE_URL: process.env.KEEPERHUB_BASE_URL || '',
  KEEPERHUB_WALLET_ADDRESS: process.env.KEEPERHUB_WALLET_ADDRESS || '',
  KEEPERHUB_WEBHOOK_URL: process.env.KEEPERHUB_WEBHOOK_URL || '',
  KEEPERHUB_TOKEN: process.env.KEEPERHUB_TOKEN || '',

  // ENS
  ENS_NAME: process.env.ENS_NAME || '',
  ENS_RPC_URL: process.env.ENS_RPC_URL || 'https://ethereum-rpc.publicnode.com',

  // Payment
  PRICE_PER_JOB_USDC: process.env.PRICE_PER_JOB_USDC || '0.01',
  CHAIN: (process.env.CHAIN as 'base-sepolia' | 'base') || 'base-sepolia',

  // Test Net
  BASE_SEPOLIA_RPC_URL: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
}