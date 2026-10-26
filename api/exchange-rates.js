// Cotação pública USD/BRL. Não recebe tokens Meta nem dados dos assinantes.
const memo = new Map();
const iso = d => d.toISOString().slice(0,10);
const valid = v => /^\d{4}-\d{2}-\d{2}$/.test(v||'') && Number.isFinite(Date.parse(v+'T12:00:00Z')) && iso(new Date(v+'T12:00:00Z'))===v;
const bcbDate = v => v.slice(5,7)+'-'+v.slice(8,10)+'-'+v.slice(0,4);
export async function getRates(from,to,fetcher=fetch){
 if(!valid(from)||!valid(to)||from>to||(Date.parse(to)-Date.parse(from))/86400000>366)throw Object.assign(Error('Intervalo inválido'),{status:400});
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(to>today)throw Object.assign(Error('Data futura'),{status:400});
 const start=new Date(from+'T12:00:00Z');start.setUTCDate(start.getUTCDate()-14);
 const url=new URL('https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)');
 url.searchParams.set('@dataInicial',"'"+bcbDate(iso(start))+"'");url.searchParams.set('@dataFinalCotacao',"'"+bcbDate(to)+"'");url.searchParams.set('$format','json');url.searchParams.set('$top','10000');
 const response=await fetcher(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Cotação indisponível');
 const body=await response.json();if(!Array.isArray(body.value)||body['@odata.nextLink'])throw Error('Cotação incompleta');
 const quotes=body.value.map(r=>({date:String(r.dataHoraCotacao||'').slice(0,10),rate:Number(r.cotacaoVenda)})).filter(r=>valid(r.date)&&r.rate>0&&Number.isFinite(r.rate)).sort((a,b)=>a.date.localeCompare(b.date));
 const rates={};for(let d=new Date(from+'T12:00:00Z');iso(d)<=to;d.setUTCDate(d.getUTCDate()+1)){const day=iso(d),q=quotes.filter(x=>x.date<=day).at(-1);if(!q)throw Error('Cotação indisponível para '+day);rates[day]={rate:q.rate,quoteDate:q.date,provisional:day===today&&q.date!==day};}
 return {source:'BCB PTAX venda',currency:'USD',base:'BRL',from,to,rates};
}
export default async function handler(req,res){
 res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
 if(req.method==='OPTIONS')return res.status(204).end();if(req.method!=='GET')return res.status(405).json({error:'Utilize GET.'});
 const from=String(req.query?.from||''),to=String(req.query?.to||''),key=from+'|'+to;
 try{const cached=memo.get(key);if(cached&&cached.expires>Date.now()){res.setHeader('Cache-Control','public, max-age=300');return res.status(200).json(cached.body);}
 const body=await getRates(from,to);if(memo.size>100)memo.clear();memo.set(key,{body,expires:Date.now()+300000});res.setHeader('Cache-Control','public, max-age=300');return res.status(200).json(body);
 }catch(e){res.setHeader('Cache-Control','no-store');return res.status(e.status||503).json({error:e.status===400?'Período inválido.':'Não foi possível consultar a cotação. Tente novamente.'});}
}
