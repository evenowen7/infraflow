import { pathToFileURL } from 'node:url';
import { db } from '../apps/api/src/db.js';
import { hashPassword } from '../apps/api/src/security.js';
import type { Role } from '@prisma/client';

export async function seed() {
  if (process.env.APP_MODE !== 'DEMO') throw new Error('Seed hanya untuk DEMO');
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 12) throw new Error('DEMO_PASSWORD wajib minimal 12 karakter');
  for (const [id,name] of [['team-platform','Platform Engineering'],['team-data','Data Services']]) {
    await db.team.upsert({where:{id},update:{},create:{id:id!,name:name!}});
  }
  const accounts: [string, string, Role, string][] = [
    ['requester','Raka Pratama','REQUESTER','team-platform'], ['approver','Nadia Putri','APPROVER','team-platform'],
    ['operator','Dimas Santoso','OPERATOR','team-platform'], ['admin','Admin Platform','PLATFORM_ADMIN','team-platform'],
    ['auditor','Auditor Internal','AUDITOR','team-platform'], ['requester2','Sinta Wijaya','REQUESTER','team-data'],
  ];
  for (const [key,name,role,teamId] of accounts) {
    const user = await db.user.upsert({where:{email:`${key}@demo.infraflow.test`},update:{},create:{id:`user-${key}`,email:`${key}@demo.infraflow.test`,name,passwordHash:hashPassword(password)}});
    await db.roleAssignment.upsert({where:{userId_teamId_role:{userId:user.id,teamId,role}},update:{},create:{userId:user.id,teamId,role,environments:['DEV','TEST','PRODUCTION']}});
  }
  for (const [id,name,os] of [['ubuntu-24','Ubuntu Server 24.04','Ubuntu 24.04'],['debian-12','Debian 12','Debian 12'],['rocky-9','Rocky Linux 9','Rocky Linux 9']]) {
    await db.template.upsert({where:{id},update:{},create:{id:id!,name:name!,os:os!}});
  }
  for (const [id,name,cpu,ramGb,diskGb] of [['small','Small',2,4,40],['medium','Medium',4,8,80],['large','Large',8,16,160]] as const) {
    await db.sizeProfile.upsert({where:{id},update:{},create:{id,name,cpu,ramGb,diskGb}});
  }
  for (const [id,name,cidr,teamId] of [['net-platform','Platform demo','192.0.2.0/24','team-platform'],['net-test','Test demo','198.51.100.0/24','team-platform'],['net-data','Data demo','203.0.113.0/24','team-data']]) {
    await db.networkProfile.upsert({where:{id},update:{},create:{id:id!,name:name!,cidr:cidr!,teamId:teamId!}});
  }
  for (let i=1;i<=12;i++) {
    const dataTeam = i>=10;
    const poweredOn = [2,3,5,10].includes(i);
    await db.resource.upsert({where:{id:`vm-${i}`},update:{},create:{
      id:`vm-${i}`,externalId:`demo-vm-${String(i).padStart(3,'0')}`,name:`${dataTeam?'data':'platform'}-${['api','worker','db','web'][i%4]}-${String(i).padStart(2,'0')}`,
      teamId:dataTeam?'team-data':'team-platform', owner:`${dataTeam?'requester2':'requester'}@demo.infraflow.test`,environment:i===9?'PRODUCTION':i%3===0?'TEST':'DEV',
      cpu:2,ramGb:4,diskGb:40,networkId:dataTeam?'net-data':'net-platform',templateId:'ubuntu-24',
      powerState:poweredOn?'poweredOn':'poweredOff',guestState:poweredOn?'ready':'stopped',serviceHealthy:poweredOn && i!==5,
      bootMarker:poweredOn?`seed-boot-${i}`:null,guestRebootSupported:i!==3,scenario:i===5?'VERIFY_FAIL':'NORMAL',
    }});
  }
  const services = [
    {action:'POWER_ON_VM' as const,name:'Power on VM',description:'Nyalakan VM nonprod dengan approval dan verifikasi layanan.',enabled:true,verifierContract:{powerState:'poweredOn',guestReady:true,serviceHealthy:true}},
    {action:'RESTART_VM' as const,name:'Graceful restart VM',description:'Restart guest OS tanpa hard reset; validasi boot marker.',enabled:true,verifierContract:{bootMarkerChanged:true,guestReady:true,serviceHealthy:true}},
    {action:'CREATE_VM' as const,name:'Create VM',description:'Provisioning dari template, ukuran, dan network standar.',enabled:true,verifierContract:{externalId:true,specificationMatch:true,bootstrapReady:true}},
  ];
  for (const service of services) await db.serviceDefinition.upsert({where:{action:service.action},update:{enabled:true},create:{...service,schema:service.action==='CREATE_VM'?{required:['name','templateId','sizeId','networkId','teamId','owner','environment']}:{required:['resourceId','reason']}}});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seed().then(()=>console.log('Seed DEMO selesai; data yang ada tidak direset.')).finally(()=>db.$disconnect());
}
