import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Action, Prisma, Resource, Request } from '@prisma/client';
import { z } from 'zod';
import { createVmParameters } from '../../contracts/src/index.js';

export const createMetadataSchema = z.object({
  parameters:createVmParameters,
  template:z.object({id:z.string(),name:z.string(),os:z.string(),enabled:z.boolean()}),
  size:z.object({id:z.string(),name:z.string(),cpu:z.number().int().positive(),ramGb:z.number().int().positive(),diskGb:z.number().int().positive()}),
  network:z.object({id:z.string(),name:z.string(),cidr:z.string(),teamId:z.string()}),
});
export type CreateMetadata = z.infer<typeof createMetadataSchema>;
export type Observation = Pick<Resource, 'id'|'externalId'|'adapterId'|'name'|'teamId'|'owner'|'environment'|'powerState'|'guestState'|'serviceHealthy'|'bootMarker'|'observedAt'|'cpu'|'ramGb'|'diskGb'|'networkId'|'templateId'|'mutationCount'|'healthRequired'|'guestRebootSupported'>;
export interface ExecutionContext {
  create?: CreateMetadata|null;
  before?: Pick<Observation,'id'|'externalId'|'adapterId'|'bootMarker'>|null;
  operationId?: string|null;
  dispatched?: boolean;
}
export interface Verification { verified: boolean; checks: Record<string, boolean>; observation: Observation|null; proof?: ExecutionContext }
export interface DispatchResult { operationId: string; uncertain: boolean; resourceId: string }
export interface InventoryAdapter { observe(tx: Prisma.TransactionClient, resourceId: string): Promise<Observation> }
export interface ExecutionAdapter extends InventoryAdapter {
  precheck(action: Action, resource: Resource|null, context?: ExecutionContext): { ready: boolean; checks: Record<string, boolean> };
  dispatch(tx: Prisma.TransactionClient, request: Request, resource: Resource|null, operationId: string, context?: ExecutionContext): Promise<DispatchResult>;
  verify(action: Action, resource: Resource|null, context?: ExecutionContext): Verification;
}
export interface ServiceDeskAdapter {
  fetchAuthoritativeTicket(externalId: string): Promise<unknown>;
  updateResult(externalId: string, result: unknown): Promise<void>;
}
export interface SecretProvider { get(name: string): string | undefined }
export class EnvironmentSecretProvider implements SecretProvider {
  get(name: string) { return process.env[name]; }
}
export function observation(r: Resource): Observation {
  return { id:r.id,externalId:r.externalId,adapterId:r.adapterId,name:r.name,teamId:r.teamId,owner:r.owner,environment:r.environment,powerState:r.powerState,guestState:r.guestState,serviceHealthy:r.serviceHealthy,bootMarker:r.bootMarker,observedAt:r.observedAt,cpu:r.cpu,ramGb:r.ramGb,diskGb:r.diskGb,networkId:r.networkId,templateId:r.templateId,mutationCount:r.mutationCount,healthRequired:r.healthRequired,guestRebootSupported:r.guestRebootSupported };
}
export function createdExternalId(operationId: string) {
  const uuid = z.string().uuid().parse(operationId.startsWith('demo-op-')?operationId.slice(8):'');
  return `demo-created-${uuid}`;
}
export class DemoAdapter implements ExecutionAdapter {
  async observe(tx: Prisma.TransactionClient, id: string) { return observation(await tx.resource.findUniqueOrThrow({where:{id}})); }
  precheck(action: Action, resource: Resource|null, context: ExecutionContext = {}) {
    if (action==='CREATE_VM') {
      const create = context.create;
      const checks = { noExistingTarget:resource===null,catalog:!!create?.template.enabled,nonproduction:create?.parameters.environment==='DEV'||create?.parameters.environment==='TEST' };
      return {ready:Object.values(checks).every(Boolean),checks};
    }
    const checks: Record<string,boolean> = { nonproduction:!!resource && resource.environment!=='PRODUCTION', configured:resource?.adapterId==='demo', knownPowerState:!!resource && ['poweredOn','poweredOff'].includes(resource.powerState) };
    if (action==='RESTART_VM') Object.assign(checks,{poweredOn:resource?.powerState==='poweredOn',guestReady:resource?.guestState==='ready',guestRebootSupported:resource?.guestRebootSupported===true,serviceCheckConfigured:resource?.healthRequired===true,serviceHealthy:resource?.serviceHealthy===true,bootMarkerKnown:!!resource?.bootMarker});
    return { ready:Object.values(checks).every(Boolean),checks };
  }
  async dispatch(tx: Prisma.TransactionClient, request: Request, resource: Resource|null, operationId: string, context: ExecutionContext = {}): Promise<DispatchResult> {
    if (!this.precheck(request.action,resource,context).ready) throw new Error('Precheck adapter tidak terpenuhi');
    if (request.action==='CREATE_VM') {
      const create = createMetadataSchema.parse(context.create);
      if (request.resourceId || !isDeepStrictEqual(createVmParameters.parse(request.parameters),create.parameters)) throw new Error('Spesifikasi create tidak cocok');
      const {parameters:p,size} = create;
      const created = await tx.resource.create({data:{externalId:createdExternalId(operationId),adapterId:'demo',name:p.name,teamId:p.teamId,owner:p.owner,environment:p.environment,cpu:size.cpu,ramGb:size.ramGb,diskGb:size.diskGb,templateId:create.template.id,networkId:create.network.id,powerState:'poweredOn',guestState:'ready',serviceHealthy:true,healthRequired:true,guestRebootSupported:true,bootMarker:`${operationId}:boot`,mutationCount:1,scenario:'NORMAL'}});
      await tx.request.update({where:{id:request.id},data:{resourceId:created.id}});
      return {operationId,resourceId:created.id,uncertain:false};
    }
    if (!resource) throw new Error('Target tidak ditemukan');
    await tx.resource.update({where:{id:resource.id},data:{powerState:'poweredOn',guestState:'ready',serviceHealthy:resource.scenario!=='VERIFY_FAIL',bootMarker:randomUUID(),mutationCount:{increment:1},observedAt:new Date()}});
    return { operationId,resourceId:resource.id,uncertain:resource.scenario==='TIMEOUT_AFTER_DISPATCH' };
  }
  verify(action: Action, resource: Resource|null, context: ExecutionContext = {}): Verification {
    if (!resource) return {verified:false,checks:{targetExists:false,dispatchProof:context.dispatched===true},observation:null,proof:context};
    const checks: Record<string,boolean> = { poweredOn:resource.powerState==='poweredOn',guestReady:!resource.healthRequired||resource.guestState==='ready',serviceHealthy:!resource.healthRequired||resource.serviceHealthy };
    if (action==='RESTART_VM') Object.assign(checks,{
      dispatchProof:context.dispatched===true,
      sameTarget:context.before?.id===resource.id && context.before.externalId===resource.externalId && context.before.adapterId===resource.adapterId,
      bootMarkerChanged:!!context.before?.bootMarker && !!resource.bootMarker && context.before.bootMarker!==resource.bootMarker,
      guestReady:resource.guestState==='ready',serviceHealthy:resource.healthRequired && resource.serviceHealthy,guestRebootSupported:resource.guestRebootSupported,
    });
    if (action==='CREATE_VM') {
      const create = context.create;
      let externalId: string|null = null;
      try { externalId = createdExternalId(context.operationId??''); } catch { /* Missing operation identity cannot prove creation. */ }
      Object.assign(checks,{
        dispatchProof:context.dispatched===true,
        externalId:externalId!==null && resource.externalId===externalId && resource.adapterId==='demo',
        specificationMatch:!!create && resource.name===create.parameters.name && resource.teamId===create.parameters.teamId && resource.owner===create.parameters.owner && resource.environment===create.parameters.environment && resource.templateId===create.template.id && resource.networkId===create.network.id && resource.cpu===create.size.cpu && resource.ramGb===create.size.ramGb && resource.diskGb===create.size.diskGb,
        bootstrapReady:!!context.operationId && resource.bootMarker===`${context.operationId}:boot` && resource.guestState==='ready' && resource.healthRequired && resource.serviceHealthy && resource.guestRebootSupported && resource.mutationCount===1,
      });
    }
    return { verified:Object.values(checks).every(Boolean), checks, observation:observation(resource),...(action==='POWER_ON_VM'?{}:{proof:context}) };
  }
}
export class JenkinsAdapter implements ExecutionAdapter {
  private unavailable(): never { throw new Error('NOT_CONFIGURED: Jenkins belum tersambung dan belum diverifikasi; tidak ada fallback DEMO'); }
  async observe(): Promise<Observation> { return this.unavailable(); }
  precheck(): {ready: boolean; checks:Record<string,boolean>} { return this.unavailable(); }
  async dispatch(): Promise<DispatchResult> { return this.unavailable(); }
  verify(): Verification { return this.unavailable(); }
}
