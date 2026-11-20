import 'dotenv/config';
import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir:'tests/e2e',fullyParallel:false,workers:1,timeout:60_000,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:process.env.E2E_BASE_URL??'http://localhost:5173',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],
  webServer:{command:'npm run dev',url:process.env.E2E_BASE_URL??'http://localhost:5173',reuseExistingServer:true,timeout:120_000},
});
