
(function(){
  window.__rpc = []; window.__rpcHandlers = window.__rpcHandlers || {};
  const chain = () => { const t = {data:[],error:null,count:0};
    const p = new Proxy(function(){}, { get(_, k){ if (k === 'then') return (res, rej) => Promise.resolve(t).then(res, rej); return () => p; }, apply(){ return p; } }); return p; };
  const client = {
    rpc(name, params){ window.__rpc.push({name, params}); const h = window.__rpcHandlers[name]; return Promise.resolve(h ? h(params) : {data:null,error:null}); },
    from(){ return chain(); },
    auth: { getSession(){ return Promise.resolve({data:{session: window.__session || null}}); },
            onAuthStateChange(cb){ window.__authCb = cb; return {data:{subscription:{unsubscribe(){}}}}; },
            signInWithPassword(){ return Promise.resolve({data:{},error:{message:'stub'}}); }, signOut(){ return Promise.resolve({error:null}); },
            getUser(){ return Promise.resolve({data:{user:null},error:null}); } },
    storage: { from(){ return { upload: async()=>({error:null}), getPublicUrl:()=>({data:{publicUrl:''}}) }; } },
    channel(){ const c = { on(){ return c; }, subscribe(){ return c; } }; return c; }, removeChannel(){},
  };
  window.supabase = { createClient: () => client };
})();
