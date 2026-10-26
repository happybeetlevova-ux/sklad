const C='master-v14';
const F=['./','./index.html','./manifest.webmanifest','./icon2-192.png','./icon2-512.png','./icon2-maskable.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(F.map(u=>new Request(u,{cache:'reload'})))));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const same=new URL(e.request.url).origin===location.origin;
  const net=same?fetch(e.request.url,{cache:'no-cache'}):fetch(e.request);
  e.respondWith(net.then(r=>{if(same&&r.ok){const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp))}return r})
    .catch(()=>caches.match(e.request).then(r=>r||(same?caches.match('./index.html'):undefined))));
});
