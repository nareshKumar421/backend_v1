// sidebar.js — Shared sidebar navigation for all portal pages
(function(){
  // Don't show sidebar if not logged in
  const tok=sessionStorage.getItem('portal_token')||localStorage.getItem('token');
  let userStr=null;try{userStr=sessionStorage.getItem('portal_user');}catch(_e){}
  if(!tok||!userStr) return;

  const LINKS=[
    {href:'/',icon:'&#8962;',label:'Home',module:'home'},
    {href:'/bom',icon:'&#8862;',label:'BOM',module:'bom'},
    {href:'/production',icon:'&#9881;',label:'Production',module:'production'},
    {href:'/issue-production',icon:'&#128295;',label:'Issue',module:'production'},
    {href:'/receipt-production',icon:'&#128230;',label:'Receipt',module:'production'},
    {href:'/close-production',icon:'&#128274;',label:'Close',module:'production'},
    {href:'/grpo',icon:'&#128196;',label:'GRPO',module:'grpo'},
    {href:'/approvals',icon:'&#9989;',label:'Approvals',module:'approvals'},
    {href:'/register',icon:'&#9639;',label:'Customers',module:'customers'},
    {href:'/vendor-register',icon:'&#127981;',label:'Vendors',module:'vendors'},
    {href:'/budget',icon:'&#128176;',label:'Budget',module:'budget'},
    {href:'/journal-entries',icon:'&#128209;',label:'Journal Entries',module:'journal-entries'},
    {href:'/documents',icon:'&#128196;',label:'Documents',module:'documents'},
    {href:'/sap-approvals',icon:'&#9989;',label:'SAP Approvals',module:'sap-approvals'},
    {href:'/reports',icon:'&#128202;',label:'Reports',module:'reports'},
    {href:'/admin',icon:'&#9881;',label:'Admin',module:'admin',adminOnly:true},
  ];

  const path=window.location.pathname;
  let user=null;
  try{const u=sessionStorage.getItem('portal_user');if(u)user=JSON.parse(u);}catch(_e){}
  const isAdmin=user?.role==='admin'||user?.role==='sap_adder';
  const userModules=user?.modules||null; // null = all access (backward compat)

  // Load theme CSS once; most pages already include it.
  if(!document.querySelector('link[href="/theme.css"]')){
    const themeLink=document.createElement('link');themeLink.rel='stylesheet';themeLink.href='/theme.css';document.head.appendChild(themeLink);
  }

  // Remove existing nav
  const oldNav=document.querySelector('nav');
  if(oldNav)oldNav.remove();

  const style=document.createElement('style');
  style.textContent=`
    /* ── SIDEBAR BASE ────────────────────── */
    .sb{position:fixed;left:0;top:0;bottom:0;background:linear-gradient(180deg,#047e7e 0%,#035b5b 100%);border-right:none;z-index:400;display:flex;flex-direction:column;overflow-x:hidden;overflow-y:auto;box-shadow:2px 0 12px rgba(0,0,0,.08)}
    .sb-logo{padding:14px 12px;text-align:center;border-bottom:1px solid rgba(255,255,255,.12);flex-shrink:0}
    .sb-logo span{background:#fff;color:#047e7e;font-family:'Bebas Neue',sans-serif;font-size:14px;letter-spacing:2px;padding:4px 10px;border-radius:6px;white-space:nowrap;font-weight:800}
    .sb-links{flex:1;overflow-y:auto;overflow-x:hidden;padding:8px 0}
    .sb-links::-webkit-scrollbar{width:3px}.sb-links::-webkit-scrollbar-thumb{background:rgba(255,255,255,.2);border-radius:2px}
    .sb-link{display:flex;align-items:center;gap:12px;padding:10px 16px;color:rgba(255,255,255,.7);text-decoration:none;font-size:12px;font-weight:600;white-space:nowrap;transition:all .15s;border-left:3px solid transparent;font-family:'Space Grotesk',sans-serif;margin:1px 0}
    .sb-link:hover{color:#fff;background:rgba(255,255,255,.08)}
    .sb-link.active{color:#fff;background:rgba(255,255,255,.14);border-left-color:#fff;font-weight:700}
    .sb-link .sb-ico{width:22px;text-align:center;font-size:16px;flex-shrink:0;opacity:.85}
    .sb-link.active .sb-ico{opacity:1}
    .sb-link .sb-lbl{font-size:12px}
    .sb-bottom{padding:10px;border-top:1px solid rgba(255,255,255,.12);flex-shrink:0}
    .sb-user{font-size:10px;color:rgba(255,255,255,.5);text-align:center;padding:4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sb-user .sb-role{display:block;font-size:11px;font-weight:700;color:rgba(255,255,255,.9);text-transform:uppercase;margin-bottom:2px}
    .sb-logout{width:100%;padding:8px;border-radius:8px;font-size:11px;font-weight:700;border:1px solid rgba(255,255,255,.2);color:rgba(255,255,255,.6);background:none;cursor:pointer;font-family:'Space Grotesk',sans-serif;transition:all .15s}
    .sb-logout:hover{border-color:#fff;color:#fff;background:rgba(255,255,255,.08)}
    .sb-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:399;display:none}
    .sb-overlay.show{display:block}

    /* ── DESKTOP ──────────────────────────── */
    @media(min-width:769px){
      .sb{width:232px;transition:width .2s ease}
      .sb .sb-lbl{display:inline}
      .sb .sb-user,.sb .sb-logout{display:block}
      body{margin-left:232px!important;transition:margin-left .2s ease}
      .mob-bar{display:none!important}
      .sb-overlay{display:none!important}
    }

    /* ── MOBILE ───────────────────────────── */
    @media(max-width:768px){
      .sb{width:260px;transform:translateX(-100%);transition:transform .25s ease}
      .sb.open{transform:translateX(0)}
      .sb .sb-lbl{display:inline}
      .sb .sb-user,.sb .sb-logout{display:block}
      body{margin-left:0!important;padding-bottom:72px!important}
      .mob-bar{position:fixed;bottom:0;left:0;right:0;height:66px;background:#fff;border-top:1px solid #e0e0e0;z-index:300;display:flex;align-items:center;justify-content:space-around;padding:6px;box-shadow:0 -2px 10px rgba(0,0,0,.04)}
      .mob-bar a{display:flex;flex-direction:column;align-items:center;gap:2px;color:#6a6d70;text-decoration:none;font-size:9px;font-weight:600;font-family:'Space Grotesk',sans-serif;padding:6px 4px;border-radius:8px;transition:all .12s;flex:1;text-align:center}
      .mob-bar a .mb-ico{font-size:18px}
      .mob-bar a.active{color:#047e7e;background:rgba(4,126,126,.06)}
      .mob-bar .mb-more{color:#6a6d70;cursor:pointer;border:none;background:none;font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:600;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px;flex:1}
      .mob-bar .mb-more .mb-ico{font-size:18px}
    }
  `;
  document.head.appendChild(style);

  // Build sidebar
  const sb=document.createElement('div');sb.className='sb';sb.id='sidebar';
  const hasModule=(m)=>!userModules||isAdmin||m==='home'||userModules.includes(m);
  const linksHtml=LINKS.filter(l=>{
    if(l.adminOnly&&!isAdmin)return false;
    return hasModule(l.module);
  }).map(l=>{
    const active=path===l.href||(l.href!=='/'&&path.startsWith(l.href));
    return`<a href="${l.href}" class="sb-link${active?' active':''}"><span class="sb-ico">${l.icon}</span><span class="sb-lbl">${l.label}</span></a>`;
  }).join('');
  sb.innerHTML=`<div class="sb-logo"><span>SAP B1</span></div>
    <div class="sb-links">${linksHtml}</div>
    <div class="sb-bottom">
      <div class="sb-user"><span class="sb-role">${(user?.role||'').replace('_',' ')}</span>${user?.name||user?.username||''}</div>
      <button class="sb-logout" id="sb-logout">Logout</button>
    </div>`;
  document.body.prepend(sb);

  // Mobile bottom bar
  const mobLinks=[
    {href:'/',icon:'&#8962;',label:'Home'},
    {href:'/production',icon:'&#9881;',label:'Prod'},
    {href:'/approvals',icon:'&#9989;',label:'Approve'},
    {href:'/grpo',icon:'&#128196;',label:'GRPO'},
    {href:'/budget',icon:'&#128176;',label:'Budget'},
  ];
  const mobBar=document.createElement('div');mobBar.className='mob-bar';
  mobBar.innerHTML=mobLinks.map(l=>{
    const active=path===l.href||(l.href!=='/'&&path.startsWith(l.href));
    return`<a href="${l.href}"${active?' class="active"':''}><span class="mb-ico">${l.icon}</span>${l.label}</a>`;
  }).join('')+`<button class="mb-more" id="mob-more"><span class="mb-ico">&#9776;</span>More</button>`;
  document.body.appendChild(mobBar);

  // Overlay
  const overlay=document.createElement('div');overlay.className='sb-overlay';overlay.id='sb-overlay';
  document.body.appendChild(overlay);

  // Mobile toggle
  const toggleMob=()=>{sb.classList.toggle('open');overlay.classList.toggle('show');};
  document.getElementById('mob-more').onclick=toggleMob;
  overlay.onclick=toggleMob;
  sb.querySelectorAll('.sb-link').forEach(l=>{l.addEventListener('click',()=>{if(window.innerWidth<=768){sb.classList.remove('open');overlay.classList.remove('show');}});});

  // Logout
  document.getElementById('sb-logout').onclick=()=>{sessionStorage.clear();localStorage.removeItem('token');window.location.href='/';};
})();
