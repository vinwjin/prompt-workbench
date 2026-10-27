import {resultAsset} from './library.js';

// Cache only database-derived rows. Runtime queues and source progress stay live.
export class StateSnapshot {
  constructor(store){this.store=store;this.parts=new Map();}
  read(key,kinds,build){const stamp=kinds.map(k=>this.store.kindRevision(k)).join(':');const cached=this.parts.get(key);if(cached?.stamp===stamp)return cached.value;const value=build();this.parts.set(key,{stamp,value});return value;}
  get(){const s=this.store;return {
    providers:this.read('providers',['providers'],()=>s.list('providers').map(p=>s.publicProvider(p))),
    templates:this.read('templates',['templates'],()=>s.list('templates').filter(t=>!t.deletedAt)),
    assets:this.read('assets',['assets','jobs'],()=>s.list('assets').map(a=>({...a,isResult:resultAsset(s,a)}))),
    folders:this.read('folders',['folders'],()=>s.list('folders')),
    modelLists:this.read('models',['modelLists'],()=>s.list('modelLists')),
    recovery:this.read('recovery',['jobs'],()=>s.recoverySummary()),
    jobs:this.read('jobs',['jobs'],()=>s.jobPage({limit:250}).jobs),
    draft:this.read('draft',['drafts'],()=>s.get('drafts','workbench'))
  };}
}
