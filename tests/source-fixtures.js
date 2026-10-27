// Explicit test-only permissions for synthetic fetchers. Production defaults remain restricted.
import {Sources as ProductionSources} from '../src/sources.js';
import {createWorkbench as productionWorkbench} from '../src/server.js';
export * from '../src/sources.js';
const simulated=new Set(['mother','s38','s39','s40']);
export function allowSyntheticSources(sources){
  const feed=sources.feed.bind(sources),catalog=sources.catalog.bind(sources);
  sources.feed=id=>{const f=feed(id);return simulated.has(id)?{...f,syncable:true}:f;};
  sources.catalog=()=>catalog().map(f=>simulated.has(f.id)?{...f,syncable:true}:f);
  return sources;
}
export class Sources extends ProductionSources{
  constructor(store,options={}){super(store,options);if(options.fetcher)allowSyntheticSources(this);}
}
export async function createWorkbench(options){const app=await productionWorkbench(options);if(options?.sourceFetcher||options?.imageFetcher)allowSyntheticSources(app.sources);return app;}
