import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from '../../apps/api/src/db.js';

async function login(page:Page,account:string) {
  await page.goto('/');
  await page.getByLabel('Alamat email').fill(`${account}@demo.infraflow.test`);
  await page.getByLabel('Password',{exact:false}).first().fill(process.env.DEMO_PASSWORD!);
  await page.getByRole('button',{name:'Masuk ke InfraFlow'}).click();
  await expect(page.getByRole('button',{name:'Keluar dari akun'})).toBeVisible();
}
async function requestVm(page:Page,resourceId:string) {
  await page.goto(`/requests/new?resourceId=${resourceId}`);
  await page.getByRole('button',{name:'Lanjutkan'}).click();
  await page.getByLabel('Alasan operasional').fill('Pengujian E2E layanan nonprod melalui browser');
  await page.getByRole('button',{name:'Lanjutkan'}).click();
  await page.getByRole('button',{name:'Ajukan request'}).click();
  await expect(page).toHaveURL(/\/requests\/[a-f0-9-]+$/);
  await expect(page.locator('.request-status-strip')).toContainText('Menunggu persetujuan');
  return page.url().split('/').at(-1)!;
}
async function approve(page:Page,id:string) {
  await page.goto(`/requests/${id}`);
  await page.getByRole('checkbox',{name:/Saya telah meninjau snapshot/}).check();
  await page.getByLabel('Alasan keputusan').fill('Sudah meninjau target dan dampak layanan nonprod');
  await page.getByRole('button',{name:'Setujui request'}).click();
}
test('power on, approval independen, evidence, no-op dan navigasi responsif',async({browser})=>{
  const requesterContext=await browser.newContext({baseURL:process.env.E2E_BASE_URL??'http://localhost:5173'}); const approverContext=await browser.newContext({baseURL:process.env.E2E_BASE_URL??'http://localhost:5173'});
  const requester=await requesterContext.newPage(); const approver=await approverContext.newPage();
  const errors:string[]=[];requester.on('pageerror',e=>errors.push(e.message));approver.on('pageerror',e=>errors.push(e.message));
  await login(requester,'requester');
  expect(process.env.APP_MODE).toBe('DEMO');
  expect(['localhost','127.0.0.1']).toContain(new URL(requester.url()).hostname);
  const suffix=randomUUID().slice(0,8);
  const target=await db.resource.create({data:{name:`e2e-power-${suffix}`,externalId:`e2e-power-${suffix}`,adapterId:'demo',teamId:'team-platform',owner:'requester@demo.infraflow.test',environment:'DEV',cpu:2,ramGb:4,diskGb:40,networkId:'net-platform'}});
  const id=await requestVm(requester,target.id);
  await expect(requester.getByRole('button',{name:'Setujui request'})).toHaveCount(0);
  await login(approver,'approver'); await approve(approver,id);
  await expect.poll(async()=> (await (await requester.request.get(`/api/requests/${id}`)).json()).status,{timeout:15000}).toBe('SUCCEEDED');
  await requester.getByRole('button',{name:'Muat ulang',exact:true}).click();
  await expect(requester.locator('.request-status-strip')).toContainText('Berhasil');
  await requester.getByRole('tab',{name:'Eksekusi & bukti'}).click();
  await expect(requester.getByText('Terverifikasi',{exact:true})).toBeVisible();
  const downloadPromise=requester.waitForEvent('download');await requester.getByRole('link',{name:'Unduh bukti'}).click();
  const download=await downloadPromise; expect(download.suggestedFilename()).toContain(id);
  const evidence=await (await requester.request.get(`/api/requests/${id}/evidence`)).json();
  expect(evidence.mode).toBe('DEMO');expect(evidence.resource.mutationCount).toBe(target!.mutationCount+1);
  expect(evidence.approvals[0].actorId).not.toBe(evidence.requesterId);
  expect(evidence.runs[0].evidence[0].verified).toBe(true);
  await requester.screenshot({path:resolve('docs/screenshots/power-on-evidence.png'),fullPage:true});
  const noopId=await requestVm(requester,target!.id);await approve(approver,noopId);
  await expect.poll(async()=> (await (await requester.request.get(`/api/requests/${noopId}`)).json()).status).toBe('COMPLETED_NOOP');
  const noop=await (await requester.request.get(`/api/requests/${noopId}`)).json();
  expect(noop.resource.mutationCount).toBe(target!.mutationCount+1);expect(noop.runs[0].externalOperationId).toBeNull();
  for(const path of ['/','/services','/resources','/requests','/tickets','/audit','/settings']) {
    await requester.goto(path);await expect(requester.locator('main')).toBeVisible();await expect(requester.getByText('DEMO',{exact:true}).first()).toBeVisible();
  }
  await requester.goto('/');await expect(requester.getByRole('heading',{name:'Request terbaru'})).toBeVisible();await requester.screenshot({path:resolve('docs/screenshots/dashboard.png'),fullPage:true});
  await requester.setViewportSize({width:390,height:844});await requester.goto('/resources');
  await expect(requester.getByRole('button',{name:'Buka navigasi'})).toBeVisible();
  await requester.getByRole('button',{name:'Buka navigasi'}).click();await requester.getByRole('link',{name:'Layanan Katalog',exact:true}).click();
  expect(await requester.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await requesterContext.close();await approverContext.close();
});
