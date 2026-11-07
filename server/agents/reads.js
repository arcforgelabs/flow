import { z } from 'zod';
import { draftProblems } from '../core/sending.js';
const id=z.string().uuid(),time=z.string().nullable(),money=z.number().int().safe().nullable();
const totals=z.object({subtotalCents:money,taxCents:money,totalCents:money});
const stamp=v=>v?new Date(v).toISOString():null;
const cents=v=>v!==null&&v!==undefined&&v!==''&&Number.isSafeInteger(Number(v))?Number(v):null;
const amounts=(r,p='')=>({subtotalCents:cents(r[p+'subtotal']),taxCents:cents(r[p+'tax']),totalCents:cents(r[p+'total'])});
const envelope=data=>z.object({ok:z.boolean(),observedAt:z.string(),truncated:z.boolean(),code:z.enum(['record_unavailable','read_unavailable','response_too_large']).optional(),data:data.optional()});
const sourceSchema=z.object({reviewId:id,observedAt:time,source:totals,reconstructed:totals,unknownTaxLines:z.array(z.number().int().positive()),truncated:z.boolean()});
const jobSchema=z.object({id,invoiceId:id.nullable(),holdState:z.enum(['none','held','review']),mappingComplete:z.boolean(),accountingState:z.string(),sourceObservedAt:time,accountingObservedAt:time,updatedAt:time,totals,sourceReview:sourceSchema.nullable(),reconcileUrl:z.string()});
// Explicit scalar projections only. Do not select lines, source payloads, names,
// notes, arbitrary audit text, URLs, or free-text refusal messages.
async function job(db,organisationId,jobId,resource,limit) {
  const {rows}=await db.query('SELECT id,invoice_id,hold_state,mapping_complete,accounting_state,source_seen_at,accounting_checked_at,updated_at,subtotal_cents AS subtotal,tax_cents AS tax,total_cents AS total FROM billing_obligations WHERE organisation_id=$1 AND id=$2 LIMIT 1',[organisationId,jobId]);
  const r=rows[0];if(!r)return null;
  const review=await db.query("SELECT id,updated_at,left(evidence#>>'{sourceTotals,subtotalCents}',40) AS s_subtotal,left(evidence#>>'{sourceTotals,taxCents}',40) AS s_tax,left(evidence#>>'{sourceTotals,totalCents}',40) AS s_total,left(evidence#>>'{reconstructed,subtotalCents}',40) AS r_subtotal,left(evidence#>>'{reconstructed,taxCents}',40) AS r_tax,left(evidence#>>'{reconstructed,totalCents}',40) AS r_total FROM review_items WHERE organisation_id=$1 AND entity='obligation' AND flow_id=$2 AND kind='job.source_totals' AND state='open' LIMIT 1",[organisationId,jobId]);
  let sourceReview=null;
  if(review.rows[0]){
    const e=review.rows[0];
    const indices=await db.query("SELECT left(value::text,20) AS n FROM review_items r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(evidence->'unknownTaxLines')='array' THEN evidence->'unknownTaxLines' ELSE '[]'::jsonb END) AS v(value) WHERE r.organisation_id=$1 AND r.id=$2 LIMIT $3",[organisationId,e.id,limit+1]);
    sourceReview={reviewId:e.id,observedAt:stamp(e.updated_at),source:amounts(e,'s_'),reconstructed:amounts(e,'r_'),unknownTaxLines:indices.rows.slice(0,limit).map(x=>cents(x.n)).filter(x=>x>0),truncated:indices.rows.length>limit};
  }
  return {id:r.id,invoiceId:r.invoice_id,holdState:r.hold_state,mappingComplete:r.mapping_complete,accountingState:r.accounting_state,sourceObservedAt:stamp(r.source_seen_at),accountingObservedAt:stamp(r.accounting_checked_at),updatedAt:stamp(r.updated_at),totals:amounts(r),sourceReview,reconcileUrl:new URL('/reconcile/'+r.id,resource).href};
}
const refusalCodes=new Set(['not_ready','send_failed','accounting_not_connected','accounting_writes_off','xero_rate_limited','xero_validation','xero_contact_missing','xero_item_missing','xero_not_connected']);
export const READ_TOOLS=[
  {name:'flow_connection',description:'Read this instance, the current own read grant, and available read toolsets.',inputSchema:z.object({}).strict(),outputSchema:envelope(z.object({resource:z.string(),grantId:id,organisationId:id,accessLevel:z.literal('read'),toolsets:z.array(z.enum(['connection','invoices','jobs','system']))})),
    async read({grant,resource}) {return {resource,grantId:grant.id,organisationId:grant.organisation_id,accessLevel:'read',toolsets:['connection','invoices','jobs','system']};}},
  {name:'flow_invoice_diagnosis',description:'Read one exact Flow invoice ID. Explain bounded stored refusal and source-total review evidence. This is not a live source check or a complete readiness decision. Open the returned Flow links for resolution.',inputSchema:z.object({invoiceId:id}).strict(),outputSchema:envelope(z.object({id,status:z.enum(['draft','issued','void']),sendState:z.enum(['queued','sent','failed']).nullable(),refusalCode:z.string().nullable(),updatedAt:time,totals,invoiceUrl:z.string(),reasons:z.array(z.string()),job:jobSchema.nullable(),diagnosisScope:z.literal('stored_evidence_only')})),
    async read({db,grant,resource,limits},{invoiceId}){
      const {rows}=await db.query("SELECT id,status,send_state,left(send_error->>'code',64) AS refusal_code,updated_at,subtotal_cents AS subtotal,tax_cents AS tax,total_cents AS total FROM invoices WHERE organisation_id=$1 AND id=$2 LIMIT 1",[grant.organisation_id,invoiceId]);
      const r=rows[0];if(!r)return null;
      const link=await db.query('SELECT id FROM billing_obligations WHERE organisation_id=$1 AND invoice_id=$2 LIMIT 1',[grant.organisation_id,r.id]);
      const linked=link.rows[0]?await job(db,grant.organisation_id,link.rows[0].id,resource,limits.rows):null;
      const lines=await db.query('SELECT position,price_item_id AS "priceItemId",account_code AS "accountCode" FROM invoice_lines WHERE organisation_id=$1 AND invoice_id=$2 ORDER BY position LIMIT $3',[grant.organisation_id,r.id,limits.rows+1]);
      const reasons=r.status==='draft'?draftProblems({totalCents:r.total},lines.rows.slice(0,limits.rows)).map(p=>p.code):[];
      if(linked?.sourceReview)reasons.push('source_totals_review');
      if(linked?.holdState!=='none'&&linked)reasons.push('job_held');
      if(linked&&!linked.mappingComplete)reasons.push('mapping_incomplete');
      if(r.send_state==='failed')reasons.push('stored_send_refusal');
      return {id:r.id,status:r.status,sendState:r.send_state,refusalCode:r.send_state==='failed'?(refusalCodes.has(r.refusal_code)?r.refusal_code:'send_failed'):null,updatedAt:stamp(r.updated_at),totals:amounts(r),invoiceUrl:new URL('/invoices/'+r.id,resource).href,reasons:[...new Set(reasons)],job:linked,diagnosisScope:'stored_evidence_only',truncated:lines.rows.length>limits.rows||Boolean(linked?.sourceReview?.truncated)};
    }},
  {name:'flow_job_read',description:'Read one exact Flow billing-obligation UUID, its bounded stored billing state and linked invoice. No source job search, patient fields, notes or permanent job-panel URL.',inputSchema:z.object({jobId:id}).strict(),outputSchema:envelope(jobSchema.extend({invoiceUrl:z.string().nullable()})),
    async read({db,grant,resource,limits},{jobId}){const r=await job(db,grant.organisation_id,jobId,resource,limits.rows);return r?{...r,invoiceUrl:r.invoiceId?new URL('/invoices/'+r.invoiceId,resource).href:null,truncated:Boolean(r.sourceReview?.truncated)}:null;}},
  {name:'flow_health_read',description:'Read database reachability and a bounded count of due jobs for this grant organisation. It does not call an integration or expose logs, settings or worker errors.',inputSchema:z.object({}).strict(),outputSchema:envelope(z.object({database:z.literal('reachable'),dueJobs:z.number().int().nonnegative(),dueJobsCapped:z.boolean(),latestSourceObservation:time})),
    async read({db,grant,limits}){const {rows}=await db.query("SELECT (SELECT count(*)::int FROM (SELECT 1 FROM background_jobs WHERE organisation_id=$1 AND state='queued' AND run_after<=now() LIMIT $2) q) AS due,(SELECT max(source_seen_at) FROM billing_obligations WHERE organisation_id=$1) AS source_at",[grant.organisation_id,limits.rows+1]);return {database:'reachable',dueJobs:Math.min(rows[0].due,limits.rows),dueJobsCapped:rows[0].due>limits.rows,latestSourceObservation:stamp(rows[0].source_at)};}},
];
