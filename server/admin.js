'use strict';

const $ = id => document.getElementById(id);
const state = { csrf: '', clients: [], connections: [], selectedClient: '', dashboard: null, refreshTimer: null };

function esc(v) { return String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function fmtTime(v) { if (!v) return '-'; try { return new Date(v).toLocaleString(); } catch { return String(v); } }
function fmtAgo(v) { if (!v) return '-'; const d = Math.max(0, Date.now() - new Date(v).getTime()); if (d < 1000) return '刚刚'; if (d < 60000) return `${Math.floor(d/1000)}秒前`; if (d < 3600000) return `${Math.floor(d/60000)}分钟前`; return fmtTime(v); }
function fmtBytes(v) { const n=Number(v); if (!Number.isFinite(n)) return '-'; const u=['B','KiB','MiB','GiB','TiB']; let x=n,i=0; while(x>=1024&&i<u.length-1){x/=1024;i++;} return `${x.toFixed(i?1:0)} ${u[i]}`; }
function pretty(v) { return JSON.stringify(v ?? {}, null, 2); }
function show(el, yes=true) { el?.classList.toggle('hidden', !yes); }
function message(el, text, bad=false) { if (!el) return; el.textContent=text||''; el.className=`message${bad?' bad':' ok'}`; }

async function api(path, options={}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  if (state.csrf && ['POST','PUT','PATCH','DELETE'].includes((options.method||'GET').toUpperCase())) headers.set('X-CSRF-Token', state.csrf);
  const r = await fetch(`/admin/api${path}`, {...options, headers, credentials:'same-origin', cache:'no-store'});
  let data={}; try { data=await r.json(); } catch {}
  if (r.status === 401) { showDashboard(false); show($('loginView'), true); throw new Error(data.message || '登录已失效'); }
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

function showDashboard(ok) {
  show($('dashboardView'), ok);
  show($('loginView'), !ok);
  show($('changePasswordView'), false);
}

async function bootstrap() {
  try {
    const me = await api('/me');
    if (!me.authenticated) { showDashboard(false); return; }
    state.csrf = me.csrf || '';
    if (me.forcePasswordChange) { show($('loginView'),false); show($('changePasswordView'),true); return; }
    showDashboard(true); await refreshAll(); startRefresh();
  } catch { showDashboard(false); }
}

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault(); message($('loginMessage'),'登录中…');
  try {
    const d = await api('/login',{method:'POST',body:JSON.stringify({username:$('username').value,password:$('password').value})});
    state.csrf=d.csrf||'';
    if (d.forcePasswordChange) { show($('loginView'),false); show($('changePasswordView'),true); $('forceCurrentPassword').value=$('password').value; }
    else { showDashboard(true); await refreshAll(); startRefresh(); }
  } catch(err){ message($('loginMessage'),err.message,true); }
});

$('forcePasswordForm').addEventListener('submit', async e => {
  e.preventDefault(); const a=$('forceNewPassword').value,b=$('forceNewPassword2').value;
  if(a!==b) return message($('forcePasswordMessage'),'两次新密码不一致',true);
  try { const d=await api('/change-password',{method:'POST',body:JSON.stringify({currentPassword:$('forceCurrentPassword').value,newPassword:a})}); state.csrf=d.csrf||state.csrf; showDashboard(true); await refreshAll(); startRefresh(); }
  catch(err){ message($('forcePasswordMessage'),err.message,true); }
});

$('logoutBtn').addEventListener('click', async()=>{ try{await api('/logout',{method:'POST'});}catch{} state.csrf=''; clearInterval(state.refreshTimer); showDashboard(false); });
$('refreshBtn').addEventListener('click', refreshAll);

for (const b of document.querySelectorAll('.tab')) b.addEventListener('click',()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));
  document.querySelectorAll('.tab-page').forEach(x=>x.classList.toggle('active',x.dataset.page===b.dataset.tab));
  if(b.dataset.tab==='logs'){ refreshServerLogs(); refreshClientLogs(); }
});

function startRefresh(){ clearInterval(state.refreshTimer); state.refreshTimer=setInterval(refreshAll,2000); }
async function refreshAll(){
  $('refreshState').textContent='● 刷新中…';
  try { const d=await api('/dashboard'); state.dashboard=d; state.connections=d.connections||[]; state.clients=d.clients||[]; renderDashboard(d); $('refreshState').textContent='● 实时刷新'; }
  catch(err){ $('refreshState').textContent=`● 刷新失败：${err.message}`; }
}

function renderDashboard(d){
  const s=d.stats||{}; $('statConnections').textContent=s.connections??0; $('statControllers').textContent=s.controllers??0; $('statClients').textContent=s.controlledClients??0; $('statIps').textContent=s.distinctIps??0; $('statBlocked').textContent=(d.blockedIps||[]).length; $('statCoyoteClients').textContent=(d.clients||[]).filter(x=>x.connected).length;
  const r=d.system||{}, p=r.process||{}, sys=r.system||{}, cg=r.cgroup||{}, disk=r.disk||{};
  $('resRss').textContent=fmtBytes(p.rss); $('resHeap').textContent=`Heap ${fmtBytes(p.heapUsed)} / ${fmtBytes(p.heapTotal)}`;
  $('resMem').textContent=`${fmtBytes((sys.memoryTotal||0)-(sys.memoryFree||0))} / ${fmtBytes(sys.memoryTotal)}`; $('resMemFree').textContent=`可用 ${fmtBytes(sys.memoryFree)}`;
  $('resCpu').textContent=`${sys.cpuCount??'-'} 核`; $('resLoad').textContent=`Load ${Array.isArray(sys.loadavg)?sys.loadavg.map(x=>Number(x).toFixed(2)).join(' / '):'-'}`;
  $('resCgroup').textContent=cg.current!=null?`${fmtBytes(cg.current)} / ${cg.limit==null?'∞':fmtBytes(cg.limit)}`:'-';
  $('resDisk').textContent=disk.total?`${fmtBytes(disk.total-disk.free)} / ${fmtBytes(disk.total)}`:'-'; $('resDataUsed').textContent=`/data 文件 ${fmtBytes(disk.dataUsed)}`;
  $('resUptime').textContent=`进程 ${formatDuration(p.uptimeSeconds)}`; $('resOsUptime').textContent=`系统 ${formatDuration(sys.uptimeSeconds)}`;
  const pol=d.reportingPolicy||{}; $('policyList').innerHTML=Object.entries(pol).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
  $('recentSecurity').innerHTML=(d.securityEvents||[]).slice(0,10).map(x=>`<div><b>${esc(x.type)}</b><span>${esc(x.ip)} · ${esc(fmtTime(x.time))}</span><small>${esc(x.detail)}</small></div>`).join('')||'<span class="muted">暂无</span>';
  renderConnections(); renderClients(); renderBlocked(d.blockedIps||[]); renderEvents(d.securityEvents||[]); fillSettings(d.limits||{}); syncClientLogSelect();
}
function formatDuration(sec){ let n=Math.floor(Number(sec)||0); const d=Math.floor(n/86400);n%=86400;const h=Math.floor(n/3600);n%=3600;const m=Math.floor(n/60); return `${d?d+'天 ':''}${h}时${m}分`; }

const controllerUi = { expanded: new Set() };

function shortId(value, left=8, right=4){
  const s=String(value||'');
  if(s.length<=left+right+2) return s||'-';
  return `${s.slice(0,left)}…${s.slice(-right)}`;
}

function controllerGroups(){
  const controllers=state.connections.filter(x=>x.role==='controller');
  const children=state.connections.filter(x=>x.role!=='controller');
  const reportByController=new Map();
  for(const c of state.clients||[]){
    if(c?.controllerId) reportByController.set(String(c.controllerId),c);
  }
  const byController=new Map();
  for(const child of children){
    const key=String(child.controllerId||'');
    if(!byController.has(key)) byController.set(key,[]);
    byController.get(key).push(child);
  }
  const groups=controllers.map(controller=>{
    const devices=(byController.get(String(controller.id))||[]).sort((a,b)=>new Date(b.lastSeenAt||0)-new Date(a.lastSeenAt||0));
    return {controller,devices,report:reportByController.get(String(controller.id))||null};
  });
  // 极少数异常/过渡态客户端尚未找到控制端时单独归组，避免设备从管理页消失。
  const orphans=children.filter(x=>!controllers.some(c=>String(c.id)===String(x.controllerId||'')));
  if(orphans.length){
    groups.push({controller:{id:'__orphan__',ip:'-',connectedAt:null,lastSeenAt:null,messagesIn:0,role:'controller'},devices:orphans,report:null,orphan:true});
  }
  return groups;
}

function groupSearchText(group){
  return JSON.stringify({controller:group.controller,devices:group.devices,report:group.report}).toLowerCase();
}

function renderConnections(){
  const root=$('controllerTree');
  if(!root) return;
  const q=$('connectionSearch').value.trim().toLowerCase();
  const sort=$('controllerSort')?.value||'devices_desc';
  let groups=controllerGroups().filter(g=>!q||groupSearchText(g).includes(q));
  const countForGroup=g=>{ const n=Number(g.report?.deviceCount); return Number.isFinite(n)&&n>0?n:g.devices.length; };
  groups.sort((a,b)=>{
    if(a.orphan!==b.orphan) return a.orphan?1:-1;
    if(sort==='recent_desc') return new Date(b.controller.lastSeenAt||0)-new Date(a.controller.lastSeenAt||0);
    if(sort==='connected_desc') return new Date(b.controller.connectedAt||0)-new Date(a.controller.connectedAt||0);
    if(sort==='ip_asc') return String(a.controller.ip||'').localeCompare(String(b.controller.ip||''),undefined,{numeric:true});
    return (countForGroup(b)-countForGroup(a)) || (new Date(b.controller.lastSeenAt||0)-new Date(a.controller.lastSeenAt||0));
  });
  const deviceCount=groups.reduce((n,g)=>n+countForGroup(g),0);
  $('visibleControllerCount').textContent=groups.filter(g=>!g.orphan).length;
  $('visibleDeviceCount').textContent=deviceCount;
  if(!groups.length){ root.innerHTML='<div class="empty-tree muted">暂无匹配的控制端 / 郊狼设备</div>'; return; }
  root.innerHTML=groups.map(group=>{
    const c=group.controller;
    const autoExpand=Boolean(q);
    const expanded=autoExpand||controllerUi.expanded.has(String(c.id));
    const report=group.report||{};
    const privacy=(report.logUploadDisabled||report.stateUploadDisabled)?`${report.logUploadDisabled?'禁日志 ':''}${report.stateUploadDisabled?'禁状态':''}`:'允许上报';
    const reportedDeviceCount=Number(report.deviceCount);
    const attachedCount=Number.isFinite(reportedDeviceCount)&&reportedDeviceCount>0?reportedDeviceCount:group.devices.length;
    const scene=report.scene?` · ${esc(report.scene)}`:'';
    const childRows=group.devices.map((d,index)=>{
      const deviceLabel=[d.deviceName,d.deviceType].filter(Boolean).join(' · ') || `郊狼 ${index+1}`;
      const slot=d.slotId?`Slot ${esc(d.slotId)}`:'Slot -';
      return `<div class="device-child">
        <div class="device-child-index">${index+1}</div>
        <div class="device-child-main">
          <div class="device-child-title"><span class="online">●</span> ${esc(deviceLabel)}</div>
          <div class="device-child-meta"><span>${slot}</span><span>IP ${esc(d.ip||'-')}</span><span>活动 ${esc(fmtAgo(d.lastSeenAt))}</span><span>消息 ${esc(d.messagesIn??0)}</span></div>
        </div>
        <code class="device-child-id" title="${esc(d.id)}">${esc(shortId(d.id))}</code>
        <div class="device-child-actions"><button data-kick="${esc(d.id)}">踢设备</button><button class="danger" data-block="${esc(d.ip)}">封禁IP</button></div>
      </div>`;
    }).join('') || '<div class="no-device muted">当前控制端没有附属郊狼设备</div>';
    if(group.orphan){
      return `<article class="controller-card orphan ${expanded?'expanded':''}" data-controller-card="__orphan__">
        <button class="controller-row" data-toggle-controller="__orphan__">
          <span class="controller-chevron">${expanded?'▾':'▸'}</span>
          <span class="controller-main"><strong>未归属设备</strong><small>连接过渡态 / 原控制端已断开</small></span>
          <span class="device-count"><b>${group.devices.length}</b><small>郊狼</small></span>
        </button>
        <div class="controller-children ${expanded?'':'hidden'}">${childRows}</div>
      </article>`;
    }
    return `<article class="controller-card ${expanded?'expanded':''}" data-controller-card="${esc(c.id)}">
      <div class="controller-row-wrap">
        <button class="controller-row" data-toggle-controller="${esc(c.id)}">
          <span class="controller-chevron">${expanded?'▾':'▸'}</span>
          <span class="controller-main">
            <span class="controller-title"><span class="online">●</span> 控制端 <code title="${esc(c.id)}">${esc(shortId(c.id,10,5))}</code></span>
            <small>IP ${esc(c.ip||'-')} · ${esc(fmtAgo(c.lastSeenAt))}${scene}</small>
          </span>
          <span class="controller-report"><small>Coyote</small><b>${report.instanceId?esc(shortId(report.instanceId,7,4)):'未上报'}</b><em>${esc(privacy)}</em></span>
          <span class="device-count"><b>${attachedCount}</b><small>郊狼</small></span>
          <span class="controller-message-count"><b>${esc(c.messagesIn??0)}</b><small>消息</small></span>
        </button>
        <div class="controller-actions"><button data-kick="${esc(c.id)}">踢控制端</button><button class="danger" data-block="${esc(c.ip)}">封禁IP</button></div>
      </div>
      <div class="controller-children ${expanded?'':'hidden'}">${childRows}</div>
    </article>`;
  }).join('');
  bindControllerTreeActions();
}

function bindControllerTreeActions(){
  document.querySelectorAll('[data-toggle-controller]').forEach(b=>b.onclick=()=>{
    const id=String(b.dataset.toggleController||'');
    if(controllerUi.expanded.has(id)) controllerUi.expanded.delete(id); else controllerUi.expanded.add(id);
    renderConnections();
  });
  bindRowActions();
}

function renderClients(){ const q=$('clientSearch').value.trim().toLowerCase(); const rows=state.clients.filter(x=>!q||JSON.stringify(x).toLowerCase().includes(q)); $('clientsBody').innerHTML=rows.map(x=>`<tr><td>${x.connected?'<span class="online">● 在线</span>':'<span class="offline">○ 离线</span>'}</td><td>${esc(x.ip||'-')}</td><td><code>${esc(x.instanceId)}</code></td><td><code>${esc(x.controllerId||'-')}</code></td><td>${esc(x.scene||'-')}<br><small>HP ${esc(x.hp??'-')}</small></td><td>${esc(x.deviceCount??0)}</td><td>${esc(x.logCount??0)}</td><td>${(x.logUploadDisabled||x.stateUploadDisabled)?`${x.logUploadDisabled?'禁日志 ':''}${x.stateUploadDisabled?'禁状态':''}`:'允许'}</td><td>${esc(fmtAgo(x.lastSeenAt))}</td><td><button data-detail="${esc(x.instanceId)}">详情</button></td></tr>`).join('')||'<tr><td colspan="10" class="muted">暂无 Coyote 上报</td></tr>'; document.querySelectorAll('[data-detail]').forEach(b=>b.onclick=()=>openClientDetail(b.dataset.detail)); }
function bindRowActions(){ document.querySelectorAll('[data-kick]').forEach(b=>b.onclick=()=>openKick(b.dataset.kick)); document.querySelectorAll('[data-block]').forEach(b=>b.onclick=()=>openBlock(b.dataset.block)); }
$('connectionSearch').addEventListener('input',renderConnections);
$('controllerSort').addEventListener('change',renderConnections);
$('expandAllControllers').addEventListener('click',()=>{ controllerGroups().forEach(g=>controllerUi.expanded.add(String(g.controller.id))); renderConnections(); });
$('collapseAllControllers').addEventListener('click',()=>{ controllerUi.expanded.clear(); renderConnections(); });
$('clientSearch').addEventListener('input',renderClients);

async function openClientDetail(id){ state.selectedClient=id; try{const d=await api(`/client-detail?id=${encodeURIComponent(id)}`),c=d.client; $('clientDetailTitle').textContent=`${c.instanceId} · ${c.ip||'-'} · ${c.connected?'在线':'离线'}`; $('clientMetaJson').textContent=pretty({client:c.client,privacy:c.privacy,firstSeenAt:c.firstSeenAt,lastSeenAt:c.lastSeenAt}); $('clientDeviceJson').textContent=pretty(c.dg); $('clientGameJson').textContent=pretty(c.peak); $('clientMultiplayerJson').textContent=pretty(c.multiplayer); show($('clientDetailPanel'),true); $('clientDetailPanel').scrollIntoView({behavior:'smooth',block:'start'}); syncClientLogSelect(); }catch(err){alert(err.message);} }
$('closeClientDetail').onclick=()=>show($('clientDetailPanel'),false);

function syncClientLogSelect(){ const sel=$('clientLogSelect'), cur=state.selectedClient||sel.value; sel.innerHTML='<option value="">选择客户端</option>'+state.clients.map(x=>`<option value="${esc(x.instanceId)}">${esc(x.ip||'-')} · ${esc(x.instanceId)}</option>`).join(''); if([...sel.options].some(o=>o.value===cur)) sel.value=cur; }
$('clientLogSelect').addEventListener('change',()=>{state.selectedClient=$('clientLogSelect').value;refreshClientLogs();});
$('refreshServerLogs').onclick=refreshServerLogs; $('refreshClientLogs').onclick=refreshClientLogs;
async function refreshServerLogs(){ try{const d=await api('/server-logs?limit=500'); $('serverLogs').textContent=(d.logs||[]).map(x=>`${x.time||''} [${x.level||''}] ${x.message||''}`).join('\n')||'暂无服务器日志'; $('serverLogs').scrollTop=$('serverLogs').scrollHeight;}catch(err){$('serverLogs').textContent=err.message;} }
async function refreshClientLogs(){ const id=state.selectedClient||$('clientLogSelect').value; if(!id){$('clientLogs').textContent='请选择客户端。';return;} try{const d=await api(`/client-logs?id=${encodeURIComponent(id)}&limit=1000`); $('clientLogs').textContent=(d.logs||[]).map(x=>typeof x==='string'?x:`${x.time||x.timestamp||''} [${x.category||x.level||''}] ${x.event||''} ${x.detail||x.message||''}`).join('\n')||'暂无已上传日志（可能被客户端隐私设置禁止）。'; $('clientLogs').scrollTop=$('clientLogs').scrollHeight;}catch(err){$('clientLogs').textContent=err.message;} }

function renderBlocked(items){ $('blockedBody').innerHTML=items.map(x=>`<tr><td><code>${esc(x.ip)}</code></td><td>${esc(x.reason||'-')}</td><td>${esc(fmtTime(x.createdAt))}</td><td><button data-unblock="${esc(x.ip)}">解除</button></td></tr>`).join('')||'<tr><td colspan="4" class="muted">无黑名单</td></tr>'; document.querySelectorAll('[data-unblock]').forEach(b=>b.onclick=async()=>{if(!confirm(`解除封禁 ${b.dataset.unblock}？`))return; try{await api('/unblock-ip',{method:'POST',body:JSON.stringify({ip:b.dataset.unblock})});await refreshAll();}catch(err){alert(err.message);}}); }
function renderEvents(items){ $('eventsBody').innerHTML=items.map(x=>`<tr><td>${esc(fmtTime(x.time))}</td><td>${esc(x.type)}</td><td>${esc(x.ip)}</td><td>${esc(x.detail)}</td></tr>`).join('')||'<tr><td colspan="4" class="muted">暂无</td></tr>'; }

let blockIp=''; function openBlock(ip){blockIp=ip;$('blockDialogIp').textContent=ip;$('blockDialogReason').value='';$('blockDialog').showModal();}
$('blockConfirmBtn').addEventListener('click',async e=>{e.preventDefault();try{await api('/block-ip',{method:'POST',body:JSON.stringify({ip:blockIp,reason:$('blockDialogReason').value})});$('blockDialog').close();await refreshAll();}catch(err){alert(err.message);}});
$('manualBlockForm').addEventListener('submit',async e=>{e.preventDefault();try{await api('/block-ip',{method:'POST',body:JSON.stringify({ip:$('manualBlockIp').value,reason:$('manualBlockReason').value})});$('manualBlockIp').value='';$('manualBlockReason').value='';await refreshAll();}catch(err){alert(err.message);}});
let kickId=''; function openKick(id){kickId=id;$('kickDialogId').textContent=id;$('kickDialogReason').value='管理员踢下线';$('kickDialog').showModal();}
$('kickConfirmBtn').addEventListener('click',async e=>{e.preventDefault();try{await api('/kick',{method:'POST',body:JSON.stringify({clientId:kickId,reason:$('kickDialogReason').value})});$('kickDialog').close();await refreshAll();}catch(err){alert(err.message);}});

function fillSettings(s){ if(document.activeElement && $('settingsForm').contains(document.activeElement)) return; for(const [k,v] of Object.entries(s)){const el=$('settingsForm').elements.namedItem(k);if(el)el.value=v;} }
$('settingsForm').addEventListener('submit',async e=>{e.preventDefault();const out={};for(const el of new FormData(e.currentTarget).entries()){const [k,v]=el;out[k]=k==='logMode'?v:Number(v);} message($('settingsMessage'),'保存中…');try{const d=await api('/settings',{method:'POST',body:JSON.stringify(out)});fillSettings(d.settings||{});message($('settingsMessage'),'已保存并立即生效');await refreshAll();}catch(err){message($('settingsMessage'),err.message,true);}});

async function changePassword(currentPassword,newPassword){return api('/change-password',{method:'POST',body:JSON.stringify({currentPassword,newPassword})});}
$('changePasswordForm').addEventListener('submit',async e=>{e.preventDefault();const a=$('newPassword').value,b=$('newPassword2').value;if(a!==b)return message($('passwordMessage'),'两次新密码不一致',true);try{await changePassword($('currentPassword').value,a);message($('passwordMessage'),'密码已修改；其他 Session 已失效');$('currentPassword').value=$('newPassword').value=$('newPassword2').value='';}catch(err){message($('passwordMessage'),err.message,true);}});

bootstrap();
