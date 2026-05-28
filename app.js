var OWM_KEY       = ;       // openweathermap.org
var UNSPLASH_KEY  = ; 
var OWM          = 'https://api.openweathermap.org/data/2.5';
var GEO          = 'https://api.openweathermap.org/geo/1.0';
var CLAUDE_URL   = 'https://api.anthropic.com/v1/messages';
var S = {
  units: localStorage.getItem('ventus_units') || 'metric',
  activity: 'general', weather: null, forecast: null, aqi: null,
  chart: null, map: null, marker: null, raf: null, parts: [],
  ctrl: null, acTimer: null, acIdx: -1, acRes: [], activeChart: 'temp'
};
var $ = function(id) { return document.getElementById(id); };
function setText(id, v) { var e = $(id); if (e) e.textContent = v; }
function tL() { return S.units === 'metric' ? '°C' : '°F'; }
function wL() { return S.units === 'metric' ? 'km/h' : 'mph'; }
function toC(t) { return S.units === 'metric' ? t : (t - 32) * 5 / 9; }
function wind(ms) { return S.units === 'metric' ? (ms*3.6).toFixed(1)+' km/h' : ms.toFixed(1)+' mph'; }
function fmtTime(u) { return new Date(u*1000).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}); }
function shortDay(d) { return new Date(d+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short'}); }
function iconUrl(c) { return 'https://openweathermap.org/img/wn/'+c+'@2x.png'; }
var AQI = ['Good','Fair','Moderate','Poor','Very Poor'];

function comfort(c) {
  var t = [[38,'Scorching',100],[32,'Very Hot',90],[26,'Warm',75],[20,'Comfortable',60],[14,'Mild',45],[7,'Cool',30],[0,'Cold',15]];
  for (var i=0;i<t.length;i++) if (c>=t[i][0]) return {label:t[i][1],pct:t[i][2]};
  return {label:'Freezing',pct:5};
}

function saveCache(city, data) {
  var s = {}; try { s = JSON.parse(localStorage.getItem('ventus_cache'))||{}; } catch(e){}
  s[city.toLowerCase()] = Object.assign({ts:Date.now(),city:city},data);
  var keys = Object.keys(s).sort(function(a,b){return s[b].ts-s[a].ts;}).slice(0,5);
  var out = {}; keys.forEach(function(k){out[k]=s[k];}); 
  try { localStorage.setItem('ventus_cache',JSON.stringify(out)); } catch(e){}
}
function loadCache(city) {
  try { var e=JSON.parse(localStorage.getItem('ventus_cache')||'{}')[city.toLowerCase()]; return e&&Date.now()-e.ts<86400000?e:null; } catch(e){return null;}
}

// ── HISTORY ───────────────────────────────────────────────────
function getHistory() { try{return JSON.parse(localStorage.getItem('ventus_history'))||[];}catch(e){return[];} }
function addHistory(city) {
  var h = getHistory().filter(function(c){return c.toLowerCase()!==city.toLowerCase();});
  h.unshift(city); if(h.length>8) h=h.slice(0,8);
  localStorage.setItem('ventus_history',JSON.stringify(h)); renderHistory();
}
function renderHistory() {
  var list=$('historyList'); if(!list) return;
  var h=getHistory(); list.innerHTML='';
  if(!h.length){list.innerHTML='<li class="history-empty">No recent searches</li>';return;}
  h.forEach(function(city){
    var li=document.createElement('li'); li.className='history-item'; li.textContent=city;
    li.onclick=function(){var si=$('searchInput');if(si)si.value=city;getWeather(city);};
    list.appendChild(li);
  });
}

// ── TOAST / UI STATE ──────────────────────────────────────────
function toast(msg, type) {
  var c=$('toastContainer'); if(!c) return;
  var t=document.createElement('div'); t.className='toast toast-'+(type||'info');
  t.innerHTML='<span>'+(type==='success'?'✓':type==='error'?'✕':'ℹ')+'</span><span>'+msg+'</span>';
  c.appendChild(t);
  setTimeout(function(){t.classList.add('out');t.addEventListener('animationend',function(){t.remove();},{once:true});},3200);
}
function showErr(msg) {
  var b=$('errorBanner'),m=$('errorMsg'); if(!b) return;
  if(msg){if(m)m.textContent=msg;b.classList.remove('hidden');}else b.classList.add('hidden');
}
function setSkeleton(v) {
  var sk=$('skeletonLoader'),wc=$('weatherContent');
  if(sk)sk.classList.toggle('hidden',!v); if(v&&wc)wc.classList.add('hidden');
}
function showContent(v) {
  var es=$('emptyState'),wc=$('weatherContent');
  if(es)es.classList.toggle('hidden',v); if(wc)wc.classList.toggle('hidden',!v);
}

// ── API ───────────────────────────────────────────────────────
async function owmFetch(path, params, signal) {
  params.appid=OWM_KEY; params.units=S.units;
  var res=await fetch(OWM+'/'+path+'?'+new URLSearchParams(params),{signal:signal});
  if(!res.ok){
    if(res.status===404) throw new Error('City not found. Check the spelling.');
    if(res.status===401) throw new Error('Invalid API key — update OWM_KEY in app.js.');
    throw new Error('API error '+res.status);
  }
  return res.json();
}
async function fetchAQI(lat,lon) {
  try{var r=await fetch(OWM+'/air_pollution?lat='+lat+'&lon='+lon+'&appid='+OWM_KEY);return r.ok?r.json():null;}catch(e){return null;}
}
async function reverseGeo(lat,lon) {
  var r=await fetch(GEO+'/reverse?lat='+lat+'&lon='+lon+'&limit=1&appid='+OWM_KEY);
  var d=await r.json(); if(!d.length) throw new Error('No city found near your location.');
  return d[0].name;
}
async function geoSuggest(q) {
  try{var r=await fetch(GEO+'/direct?q='+encodeURIComponent(q)+'&limit=6&appid='+OWM_KEY);return r.ok?r.json():[];}catch(e){return[];}
}
async function claude(prompt, max) {
  var r=await fetch(CLAUDE_URL,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model:'claude-sonnet-4-20250514',max_tokens:max||500,messages:[{role:'user',content:prompt}]})});
  if(!r.ok) throw new Error('Claude error');
  var j=await r.json(); var t=(j.content||[]).find(function(b){return b.type==='text';});
  return (t?t.text:'').replace(/```json|```/g,'').trim();
}
async function getPhoto(city, weatherMain) {
  if(!UNSPLASH_KEY||UNSPLASH_KEY==='YOUR_UNSPLASH_KEY_HERE') return null;
  var kw={Clear:'sunny golden hour',Clouds:'overcast moody',Rain:'rainy city street',Snow:'snowy winter',Thunderstorm:'dramatic lightning',Mist:'foggy atmospheric'};
  try{
    var r=await fetch('https://api.unsplash.com/photos/random?query='+encodeURIComponent(city+' '+(kw[weatherMain]||'cityscape'))+'&orientation=landscape&client_id='+UNSPLASH_KEY);
    if(!r.ok) return null; var d=await r.json();
    return d.urls?{url:d.urls.regular,name:d.user.name,link:d.user.links.html+'?utm_source=VentuS&utm_medium=referral'}:null;
  }catch(e){return null;}
}

// ── THEME + BACKGROUND ────────────────────────────────────────
function applyTheme(id) {
  ['theme-sunny','theme-rain','theme-cloud','theme-snow','theme-storm','theme-mist'].forEach(function(t){document.body.classList.remove(t);});
  var t=id>=200&&id<300?'theme-storm':id>=300&&id<600?'theme-rain':id>=600&&id<700?'theme-snow':id>=700&&id<800?'theme-mist':id===800?'theme-sunny':'theme-cloud';
  document.body.classList.add(t); startFx(t);
}
async function applyBg(city, main) {
  var p=await getPhoto(city,main); if(!p) return;
  document.body.style.backgroundImage='linear-gradient(to bottom,rgba(6,6,10,.82),rgba(6,6,10,.72) 50%,rgba(6,6,10,.88)),url("'+p.url+'")';
  document.body.style.backgroundSize='cover,cover'; document.body.style.backgroundAttachment='fixed,fixed';
  var pc=$('photoCredit');
  if(pc){pc.classList.remove('hidden');pc.innerHTML='Photo: <a href="'+p.link+'" target="_blank">'+p.name+'</a> / Unsplash';}
}
function setFavicon(id) {
  try{
    var e=id>=200&&id<300?'⛈️':id>=300&&id<600?'🌧️':id>=600&&id<700?'❄️':id>=700&&id<800?'🌫️':id===800?'☀️':'⛅';
    var c=document.createElement('canvas');c.width=c.height=32;
    var ctx=c.getContext('2d');ctx.font='26px serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(e,16,18);
    var l=document.querySelector("link[rel='icon']")||document.createElement('link');l.rel='icon';l.href=c.toDataURL();document.head.appendChild(l);
  }catch(e){}
}

// ── PARTICLES ─────────────────────────────────────────────────
function startFx(theme) {
  if(S.raf){cancelAnimationFrame(S.raf);S.raf=null;}
  if(S.ltTimer){clearTimeout(S.ltTimer);S.ltTimer=null;}
  var cv=$('weatherCanvas'); if(!cv) return;
  var ctx=cv.getContext('2d'); ctx.clearRect(0,0,cv.width,cv.height); S.parts=[];
  if(theme==='theme-rain'||theme==='theme-storm'){
    for(var i=0;i<(theme==='theme-storm'?180:120);i++) S.parts.push(rainDrop(cv,true));
    if(theme==='theme-storm') scheduleLt(cv,ctx);
    fxLoop(cv,ctx,function(){return rainDrop(cv,false);},140);
  } else if(theme==='theme-snow'){
    for(var i=0;i<70;i++) S.parts.push(snowFlake(cv,true));
    fxLoop(cv,ctx,function(){return snowFlake(cv,false);},70);
  }
}
function fxLoop(cv,ctx,maker,max){
  function tick(){
    ctx.clearRect(0,0,cv.width,cv.height);
    S.parts.forEach(function(p){p.u();p.d(ctx);});
    S.parts=S.parts.filter(function(p){return !p.dead;});
    if(S.parts.length<max) S.parts.push(maker());
    S.raf=requestAnimationFrame(tick);
  }
  S.raf=requestAnimationFrame(tick);
}
function rainDrop(cv,rnd){
  var p={x:Math.random()*cv.width,y:rnd?Math.random()*cv.height:-20,len:Math.random()*14+7,sp:Math.random()*12+10,a:Math.random()*.25+.08,dead:false};
  p.u=function(){p.x+=0.9;p.y+=p.sp;if(p.y>cv.height+20)p.dead=true;};
  p.d=function(ctx){ctx.save();ctx.strokeStyle='rgba(147,197,253,'+p.a+')';ctx.lineWidth=.8;ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x+3,p.y+p.len);ctx.stroke();ctx.restore();};
  return p;
}
function snowFlake(cv,rnd){
  var p={x:Math.random()*cv.width,y:rnd?Math.random()*cv.height:-10,r:Math.random()*3+1,sp:Math.random()*.9+.4,dr:(Math.random()-.5)*.6,wb:Math.random()*Math.PI*2,a:Math.random()*.5+.2,dead:false};
  p.u=function(){p.wb+=.02;p.x+=p.dr+Math.sin(p.wb)*.4;p.y+=p.sp;if(p.y>cv.height+10)p.dead=true;};
  p.d=function(ctx){ctx.save();ctx.fillStyle='rgba(210,235,255,'+p.a+')';ctx.shadowColor='rgba(200,230,255,.5)';ctx.shadowBlur=4;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill();ctx.restore();};
  return p;
}
function scheduleLt(cv,ctx){
  S.ltTimer=setTimeout(function(){
    if(!document.body.classList.contains('theme-storm')) return;
    var op=.18,fade=function(){if(op<=0)return;ctx.fillStyle='rgba(200,180,255,'+op+')';ctx.fillRect(0,0,cv.width,cv.height);op-=.015;requestAnimationFrame(fade);};
    requestAnimationFrame(fade); scheduleLt(cv,ctx);
  },3000+Math.random()*6000);
}

// ── AUTOCOMPLETE ──────────────────────────────────────────────
function initAC() {
  var inp=$('searchInput'),list=$('autocompleteList'); if(!inp||!list) return;
  inp.addEventListener('input',function(){
    clearTimeout(S.acTimer); var q=inp.value.trim();
    if(q.length<2){hideAC();return;}
    S.acTimer=setTimeout(async function(){
      var res=await geoSuggest(q); S.acRes=res; S.acIdx=-1; list.innerHTML='';
      if(!res.length){hideAC();return;}
      res.forEach(function(loc,i){
        var li=document.createElement('li'); li.className='ac-item';
        li.innerHTML='<div><div>'+loc.name+'</div><div class="ac-item-sub">'+[loc.state,loc.country].filter(Boolean).join(', ')+'</div></div><span class="ac-badge">'+(loc.country||'')+'</span>';
        li.addEventListener('mousedown',function(e){e.preventDefault();inp.value=loc.name;hideAC();getWeather(loc.name);});
        list.appendChild(li);
      });
      list.classList.remove('hidden');
    },300);
  });
  inp.addEventListener('keydown',function(e){
    var items=list.querySelectorAll('.ac-item');
    if(e.key==='ArrowDown'){e.preventDefault();S.acIdx=Math.min(S.acIdx+1,items.length-1);}
    else if(e.key==='ArrowUp'){e.preventDefault();S.acIdx=Math.max(S.acIdx-1,-1);}
    else if(e.key==='Escape'){hideAC();return;}
    items.forEach(function(el,i){el.classList.toggle('selected',i===S.acIdx);});
    if(S.acIdx>=0&&S.acRes[S.acIdx]) inp.value=S.acRes[S.acIdx].name;
  });
  document.addEventListener('click',function(e){if(!e.target.closest('.search-wrap'))hideAC();});
}
function hideAC(){var l=$('autocompleteList');if(l){l.classList.add('hidden');l.innerHTML='';} S.acIdx=-1;S.acRes=[];}

// ── RENDER CURRENT WEATHER ────────────────────────────────────
function renderWeather(data, aqiData) {
  var m=data.main,w=data.weather[0],wind_=data.wind;
  setText('cityName', data.name+', '+data.sys.country);
  setText('currentDate', new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'}));
  setText('currentTemp', Math.round(m.temp)); setText('tempUnit',tL()); setText('weatherDesc',w.description);
  setText('humidity',m.humidity+'%'); setText('windSpeed',wind(wind_.speed));
  setText('visibility',data.visibility?(data.visibility/1000).toFixed(1)+' km':'—');
  setText('pressure',m.pressure+' hPa');
  var uv=data.uvi!==undefined?data.uvi:(new Date().getHours()>=6&&new Date().getHours()<=19?w.id===800?7:3:0);
  setText('uvIndex',uv.toFixed(0));
  setText('rainChance',(data.pop!==undefined?Math.round(data.pop*100):Math.round((data.clouds?.all||0)*.6))+'%');
  var aqi=aqiData?.list?.[0]?.main?.aqi; setText('aqiValue',aqi?AQI[aqi-1]:'—');
  var ic=$('weatherIcon'); if(ic){ic.src=iconUrl(w.icon);ic.alt=w.description;}
  var cf=comfort(toC(m.feels_like));
  setText('feelsLike',Math.round(m.feels_like)+tL());
  var ff=$('feelsBarFill'),fl=$('feelsBarLabel');
  if(ff)ff.style.width=cf.pct+'%'; if(fl)fl.textContent=cf.label;
  // sunrise/sunset
  var rise=data.sys.sunrise,set=data.sys.sunset,now=Math.floor(Date.now()/1000);
  var pct=Math.min(100,Math.max(0,((now-rise)/(set-rise))*100));
  setText('sunriseTime',fmtTime(rise)); setText('sunsetTime',fmtTime(set));
  setTimeout(function(){var a=$('sunArcFill'),d=$('sunDot');if(a)a.style.width=pct+'%';if(d)d.style.left=pct+'%';},400);
  setText('lastUpdated','Updated '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}));
  // alerts
  renderAlerts(data,aqiData);
}

function renderAlerts(data,aqiData){
  var c=$('alertsContainer'); if(!c) return;
  var items=[],tc=toC(data.main.temp),uv=data.uvi!==undefined?data.uvi:3,aqi=aqiData?.list?.[0]?.main?.aqi||0;
  if(uv>=8) items.push({cls:'ap-uv',t:'☀️ UV '+uv+' — Use SPF 50+'});
  else if(uv>=6) items.push({cls:'ap-uv',t:'🕶️ UV '+uv+' — Sunglasses recommended'});
  if(aqi>=4) items.push({cls:'ap-aqi',t:'😷 AQI: '+AQI[aqi-1]+' — Wear a mask'});
  if(tc>=38) items.push({cls:'ap-heat',t:'🌡️ Extreme heat — Avoid prolonged sun exposure'});
  else if(tc>=32) items.push({cls:'ap-heat',t:'🔥 Heat alert — Stay hydrated'});
  else if(tc<=2) items.push({cls:'ap-cold',t:'❄️ Near-freezing — Dress in warm layers'});
  c.innerHTML=''; if(!items.length){c.classList.add('hidden');return;}
  c.classList.remove('hidden');
  items.forEach(function(a){var el=document.createElement('div');el.className='alert-pill '+a.cls;el.textContent=a.t;c.appendChild(el);});
}

// ── RENDER FORECAST ───────────────────────────────────────────
function renderForecast(data){
  var g=$('forecastGrid'); if(!g) return; g.innerHTML='';
  var byDate={};
  data.list.forEach(function(e){var d=e.dt_txt.split(' ')[0];if(!byDate[d])byDate[d]=[];byDate[d].push(e);});
  Object.keys(byDate).slice(1,6).forEach(function(ds){
    var en=byDate[ds],noon=en.find(function(e){return e.dt_txt.includes('12:00:00');})||en[0];
    var temps=en.map(function(e){return e.main.temp;}),hi=Math.round(Math.max(...temps)),lo=Math.round(Math.min(...temps));
    var pop=Math.round(Math.max(...en.map(function(e){return(e.pop||0)*100;})));
    var card=document.createElement('div'); card.className='fc-card';
    card.innerHTML='<div class="fc-day">'+shortDay(ds)+'</div><img class="fc-icon" src="'+iconUrl(noon.weather[0].icon)+'" loading="lazy" width="50" height="50"/><div class="fc-desc">'+noon.weather[0].description+'</div><div class="fc-temps"><span class="fc-hi">'+hi+'°</span><span class="fc-lo">'+lo+'°</span></div>'+(pop>10?'<div class="fc-rain">💧 '+pop+'%</div>':'');
    g.appendChild(card);
  });
}

// ── RENDER RAIN / CHART / MAP ─────────────────────────────────
function renderRain(data){
  var el=$('rainContent'); if(!el) return;
  var bars=data.list.slice(0,4).map(function(e){return{l:fmtTime(e.dt),p:Math.round((e.pop||0)*100)};});
  var mx=Math.max(...bars.map(function(b){return b.p;}),1);
  var acc=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#60a5fa';
  el.innerHTML='<div class="rain-desc">'+(bars.some(function(b){return b.p>20;})?'Rain expected soon. Carry an umbrella.':'No significant rain in the next 12 hours.')+'</div><div class="rain-bars">'+bars.map(function(b){return '<div class="rain-col"><div class="rain-bar" style="height:'+Math.max(4,(b.p/mx)*38)+'px;background:'+acc+';opacity:'+(0.25+b.p/100*.75).toFixed(2)+'"></div><div class="rain-lbl">'+b.l+'</div></div>';}).join('')+'</div>';
}

function renderChart(data,type){
  var cv=$('weatherChart'); if(!cv||!window.Chart) return;
  type=type||'temp';
  var entries=data.list.slice(0,16),acc=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#f0b830';
  var cfgs={temp:{data:entries.map(function(e){return Math.round(e.main.temp);}),label:'Temp ('+tL()+')',color:acc},rain:{data:entries.map(function(e){return Math.round((e.pop||0)*100);}),label:'Rain %',color:'#60a5fa'},wind:{data:entries.map(function(e){return S.units==='metric'?+(e.wind.speed*3.6).toFixed(1):+e.wind.speed.toFixed(1);}),label:'Wind ('+wL()+')',color:'#c084fc'}};
  var cfg=cfgs[type]||cfgs.temp;
  if(S.chart){S.chart.destroy();S.chart=null;}
  S.chart=new Chart(cv.getContext('2d'),{type:'line',data:{labels:entries.map(function(e){return new Date(e.dt*1000).toLocaleString('en-GB',{weekday:'short',hour:'2-digit',minute:'2-digit'});}),datasets:[{label:cfg.label,data:cfg.data,borderColor:cfg.color,backgroundColor:cfg.color+'18',pointBackgroundColor:cfg.color,pointBorderColor:'transparent',pointRadius:4,pointHoverRadius:7,fill:true,tension:.42,borderWidth:2}]},options:{responsive:true,interaction:{mode:'index',intersect:false},animation:{duration:500},plugins:{legend:{display:false},tooltip:{backgroundColor:'rgba(6,6,14,.92)',titleColor:'#f3f0eb',bodyColor:'#8a7f70',borderColor:'rgba(255,255,255,.09)',borderWidth:1,padding:12,cornerRadius:10}},scales:{x:{ticks:{color:'#3c3530',maxTicksLimit:8,font:{size:11},maxRotation:0},grid:{color:'rgba(255,255,255,.04)'}},y:{ticks:{color:'#3c3530',font:{size:11}},grid:{color:'rgba(255,255,255,.04)'},beginAtZero:type==='rain'}}}});
}

function renderMap(lat,lon,city,iconCode,temp){
  if(typeof L==='undefined') return;
  if(!S.map){
    S.map=L.map('weatherMap',{zoomControl:true,scrollWheelZoom:false});
    L.tileLayer('https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',{maxZoom:19,attribution:'© Stadia Maps © OpenMapTiles © OpenStreetMap'}).addTo(S.map);
  }
  if(S.marker){S.marker.remove();S.marker=null;}
  var acc=getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()||'#f0b830';
  var icon=L.divIcon({html:'<div style="width:54px;height:54px;background:rgba(6,6,14,.88);border:1px solid rgba(255,255,255,.14);border-radius:50%;display:grid;place-items:center;backdrop-filter:blur(10px);box-shadow:0 6px 24px rgba(0,0,0,.5)"><img src="'+iconUrl(iconCode)+'" width="40" height="40"/></div>',iconSize:[54,54],iconAnchor:[27,27],className:''});
  S.marker=L.marker([lat,lon],{icon:icon}).addTo(S.map).bindPopup('<strong>'+city+'</strong><br>'+temp+tL(),{maxWidth:180});
  S.map.setView([lat,lon],11,{animate:true,duration:.8});
}

// ── AI PANELS ─────────────────────────────────────────────────
var OUTFITS={storm:{e:'⛈️',a:'Storm incoming — stay indoors if possible.',t:['Raincoat','Waterproof Boots','Umbrella']},rain:{e:'🌧️',a:'Rainy day — waterproofing essential.',t:['Raincoat','Boots','Hoodie']},snow:{e:'❄️',a:'Snow expected — layer up and waterproof.',t:['Puffer Jacket','Snow Boots','Gloves']},hot:{e:'🥵',a:'Very hot — light breathable fabrics only.',t:['Linen Shirt','Shorts','Cap']},warm:{e:'😎',a:'Warm and pleasant — keep it light.',t:['T-Shirt','Chinos','Sneakers']},mild:{e:'🧥',a:'Mild — a light jacket should do.',t:['Light Jacket','Jeans','Trainers']},cold:{e:'🧣',a:'Cold — layer up and cover extremities.',t:['Sweater','Jacket','Scarf']},freezing:{e:'🥶',a:'Freezing — maximum insulation needed.',t:['Thermals','Heavy Coat','Gloves']}};

function outfitFallback(tempC,id){
  var k=id>=200&&id<300?'storm':id>=300&&id<600?'rain':id>=600&&id<700?'snow':tempC>=32?'hot':tempC>=24?'warm':tempC>=15?'mild':tempC>=5?'cold':'freezing';
  return OUTFITS[k];
}

async function renderOutfit(data){
  var el=$('outfitContent'); if(!el) return;
  el.innerHTML='<div class="ai-loading"><span class="ai-pulse"></span>Thinking…</div>';
  var tc=toC(data.main.temp),fc=toC(data.main.feels_like);
  try{
    var r=JSON.parse(await claude('Weather-aware stylist. Temp:'+Math.round(tc)+'°C feels:'+Math.round(fc)+'°C, '+data.weather[0].description+', humidity:'+data.main.humidity+'%.\nJSON only: {"emoji":"x","advice":"2 sentences.","tags":["A","B","C"]}',350));
    el.innerHTML='<div class="outfit-icon">'+r.emoji+'</div><div class="outfit-text">'+r.advice+'</div><div class="outfit-tags">'+(r.tags||[]).map(function(t){return'<span class="outfit-tag">'+t+'</span>';}).join('')+'</div>';
  }catch(e){
    var f=outfitFallback(tc,data.weather[0].id);
    el.innerHTML='<div class="outfit-icon">'+f.e+'</div><div class="outfit-text">'+f.a+'</div><div class="outfit-tags">'+f.t.map(function(t){return'<span class="outfit-tag">'+t+'</span>';}).join('')+'</div>';
  }
}

async function renderActivity(data){
  var el=$('activityContent'); if(!el) return;
  el.innerHTML='<div class="ai-loading"><span class="ai-pulse"></span>Analysing…</div>';
  var actEl=$('activitySelect'),act=actEl?actEl.options[actEl.selectedIndex].text:'General';
  var tc=toC(data.main.temp);
  try{
    var r=JSON.parse(await claude('Outdoor expert. Rate weather for '+act+'.\nTemp:'+Math.round(tc)+'°C, '+data.weather[0].description+', wind:'+(data.wind.speed*3.6).toFixed(0)+'km/h.\nJSON only: {"score":7,"label":"Good","reason":"One sentence."}',250));
    el.innerHTML='<div style="display:flex;align-items:baseline;gap:4px;margin-bottom:10px"><span class="rating-num">'+r.score+'</span><span class="rating-denom">/ 10</span></div><div class="rating-bar-bg"><div class="rating-bar" style="width:'+(r.score*10)+'%"></div></div><div class="rating-text"><strong>'+r.label+'</strong> — '+r.reason+'</div>';
  }catch(e){
    var id=data.weather[0].id,isRain=id>=300&&id<700,s=isRain?3:tc>32?4:8,lb=isRain?'Wet':tc>32?'Hot':'Good',rs=isRain?'Rain affects conditions.':tc>32?'Quite hot today.':'Conditions look good.';
    el.innerHTML='<div style="display:flex;align-items:baseline;gap:4px;margin-bottom:10px"><span class="rating-num">'+s+'</span><span class="rating-denom">/ 10</span></div><div class="rating-bar-bg"><div class="rating-bar" style="width:'+(s*10)+'%"></div></div><div class="rating-text"><strong>'+lb+'</strong> — '+rs+'</div>';
  }
}

// ── UNITS ─────────────────────────────────────────────────────
function setUnits(u){
  S.units=u; localStorage.setItem('ventus_units',u);
  var m=$('unitMetric'),i=$('unitImperial');
  if(m)m.classList.toggle('active',u==='metric'); if(i)i.classList.toggle('active',u==='imperial');
  if(S.weather){renderWeather(S.weather,S.aqi);renderForecast(S.forecast);renderChart(S.forecast,S.activeChart);}
}

// ── MAIN FETCH PIPELINE ───────────────────────────────────────
async function getWeather(city){
  if(!city.trim()) return;
  if(S.ctrl) S.ctrl.abort(); S.ctrl=new AbortController();
  setSkeleton(true); showErr(null);
  try{
    var cD,fD,aD,fromCache=false;
    if(navigator.onLine){
      var res=await Promise.all([owmFetch('weather',{q:city},S.ctrl.signal),owmFetch('forecast',{q:city,cnt:40},S.ctrl.signal)]);
      cD=res[0]; fD=res[1]; aD=await fetchAQI(cD.coord.lat,cD.coord.lon);
      saveCache(city,{cD:cD,fD:fD,aD:aD});
    }else{
      var cached=loadCache(city);
      if(!cached) throw new Error('No internet and no cached data for this city.');
      cD=cached.cD; fD=cached.fD; aD=cached.aD; fromCache=true;
      var ob=$('offlineBanner'); if(ob)ob.classList.remove('hidden');
    }
    S.weather=cD; S.forecast=fD; S.aqi=aD;
    setSkeleton(false); showContent(true);
    applyTheme(cD.weather[0].id); setFavicon(cD.weather[0].id);
    renderWeather(cD,aD); renderForecast(fD); renderRain(fD);
    renderChart(fD,S.activeChart);
    renderMap(cD.coord.lat,cD.coord.lon,cD.name,cD.weather[0].icon,Math.round(cD.main.temp));
    setTimeout(function(){if(S.map)S.map.invalidateSize();},300);
    applyBg(cD.name,cD.weather[0].main);
    addHistory(cD.name);
    if(fromCache) toast('Showing cached data — you appear to be offline.','info');
    renderOutfit(cD); renderActivity(cD);
  }catch(err){
    if(err.name==='AbortError') return;
    setSkeleton(false); showErr(err.message||'Something went wrong.');
    toast(err.message||'Fetch failed.','error');
  }
}

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function(){
  setUnits(S.units); renderHistory(); initAC();

  // chart tabs
  var tabs=$('chartTabs');
  if(tabs) tabs.addEventListener('click',function(e){
    var t=e.target.closest('.chart-tab'); if(!t||!S.forecast) return;
    tabs.querySelectorAll('.chart-tab').forEach(function(x){x.classList.remove('active');});
    t.classList.add('active'); S.activeChart=t.dataset.chart; renderChart(S.forecast,S.activeChart);
  });

  // crowdsource
  var co=$('crowdOptions');
  if(co) co.addEventListener('click',function(e){
    var btn=e.target.closest('.crowd-btn'); if(!btn) return;
    co.querySelectorAll('.crowd-btn').forEach(function(b){b.classList.remove('selected');});
    btn.classList.add('selected');
    var city=S.weather?S.weather.name:'your area',r=btn.dataset.r;
    var msg=$('crowdMsg');
    if(msg){msg.textContent='✓ Reported "'+r+'" in '+city+'. Thanks!';msg.classList.remove('hidden');}
    setTimeout(function(){if(msg)msg.classList.add('hidden');btn.classList.remove('selected');},4000);
  });

  // search
  var si=$('searchInput'),sb=$('searchBtn');
  if(sb) sb.addEventListener('click',function(){var c=si?si.value.trim():'';if(c)getWeather(c);});
  if(si) si.addEventListener('keydown',function(e){if(e.key==='Enter'){var c=si.value.trim();if(c)getWeather(c);}});

  // geolocation
  var gb=$('geoBtn');
  if(gb) gb.addEventListener('click',async function(){
    if(!navigator.geolocation){toast('Geolocation not supported.','error');return;}
    gb.classList.add('spinning'); gb.disabled=true;
    try{
      navigator.geolocation.getCurrentPosition(async function(p){
        try{var city=await reverseGeo(p.coords.latitude,p.coords.longitude);if(si)si.value=city;await getWeather(city);}
        catch(err){showErr(err.message);toast(err.message,'error');}
        finally{gb.classList.remove('spinning');gb.disabled=false;}
      },function(err){
        gb.classList.remove('spinning');gb.disabled=false;
        var m={1:'Location permission denied.',2:'Location unavailable.',3:'Request timed out.'};
        var msg=m[err.code]||'Could not detect location.'; showErr(msg);toast(msg,'error');
      },{timeout:8000,maximumAge:60000});
    }catch(e){gb.classList.remove('spinning');gb.disabled=false;}
  });

  // units
  var um=$('unitMetric'),ui=$('unitImperial');
  if(um) um.addEventListener('click',function(){setUnits('metric');});
  if(ui) ui.addEventListener('click',function(){setUnits('imperial');});

  // activity
  var act=$('activitySelect');
  if(act) act.addEventListener('change',function(){S.activity=act.value;if(S.weather)renderActivity(S.weather);});

  // share
  var shb=$('shareBtn');
  if(shb) shb.addEventListener('click',async function(){
    var d=S.weather; if(!d) return;
    var text='Right now in '+d.name+': '+Math.round(d.main.temp)+tL()+', '+d.weather[0].description+'. Check it on VentuS!';
    try{if(navigator.share)await navigator.share({title:'VentuS',text:text,url:location.href});else{await navigator.clipboard.writeText(text);toast('Copied!','success');}}catch(e){}
  });

  // clear history
  var ch=$('clearHistory');
  if(ch) ch.addEventListener('click',function(){localStorage.removeItem('ventus_history');renderHistory();toast('History cleared.','success');});

  // offline
  var ob=$('offlineBanner');
  window.addEventListener('online',function(){if(ob)ob.classList.add('hidden');toast('Back online!','success');});
  window.addEventListener('offline',function(){if(ob)ob.classList.remove('hidden');toast('You are offline.','info');});
  if(!navigator.onLine&&ob) ob.classList.remove('hidden');

  // canvas resize
  var cv=$('weatherCanvas');
  if(cv){cv.width=window.innerWidth;cv.height=window.innerHeight;}
  window.addEventListener('resize',function(){if(cv){cv.width=window.innerWidth;cv.height=window.innerHeight;}});

  // Ctrl+K
  document.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();if(si){si.focus();si.select();}}});

  // auto-load last city
  var h=getHistory(); if(h.length){if(si)si.value=h[0];getWeather(h[0]);}
});
