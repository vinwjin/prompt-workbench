import http from 'node:http';
import {randomBytes,createHash,createPublicKey,verify} from 'node:crypto';

export const CHATGPT_CLIENT='dynamic_agent_client';
export const CHATGPT_TOKEN='https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_SCOPES='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
// Public installed-app OAuth registration, shared by compatible native clients.
export const ANTIGRAVITY_CLIENT=process.env.PW_ANTIGRAVITY_OAUTH_CLIENT_ID||'';
export const ANTIGRAVITY_CLIENT_SECRET=process.env.PW_ANTIGRAVITY_OAUTH_CLIENT_SECRET||'';
export const ANTIGRAVITY_TOKEN='https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_USER_AGENT='antigravity/hub/2.9.1 '+process.platform+'/'+process.arch;
export const ANTIGRAVITY_SCOPES=['cloud-platform','userinfo.email','userinfo.profile','cclog','experimentsandconfigs'].map(s=>'https://www.googleapis.com/auth/'+s).join(' ');
export async function validateIdentity(token,{clientId,nonce,request,now=Date.now,subject,issuer='https://auth.openai.com',jwksUrl='https://auth.openai.com/.well-known/jwks.json',algorithms=['RS256'],label='ChatGPT'}={}){
  let head,claims,parts;try{parts=token.split('.');if(parts.length!==3||token.length>20000)throw Error();head=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw Error(label+' 身份令牌格式无效');}
  const spec={RS256:{digest:'RSA-SHA256',kty:'RSA'},ES256:{digest:'sha256',kty:'EC',crv:'P-256'}}[head.alg];
  if(!spec||!algorithms.includes(head.alg)||!head.kid)throw Error(label+' 身份签名算法无效');
  const {ok,data}=await request(jwksUrl);
  const key=ok&&data.keys?.find(k=>k.kid===head.kid&&k.kty===spec.kty&&(!spec.crv||k.crv===spec.crv)&&(!k.alg||k.alg===head.alg)&&(!k.use||k.use==='sig'));
  let valid=false;try{valid=!!key&&verify(spec.digest,Buffer.from(parts[0]+'.'+parts[1]),{key:createPublicKey({key,format:'jwk'}),...(head.alg==='ES256'?{dsaEncoding:'ieee-p1363'}:{})},Buffer.from(parts[2],'base64url'));}catch{}
  if(!valid||claims.iss!==issuer||!(Array.isArray(claims.aud)?claims.aud.includes(clientId):claims.aud===clientId)||Array.isArray(claims.aud)&&claims.aud.length>1&&claims.azp!==clientId||!Number.isFinite(claims.exp)||claims.exp<=now()/1000||claims.nbf&&claims.nbf>now()/1000+30||nonce&&claims.nonce!==nonce||typeof claims.sub!=='string'||!claims.sub||subject&&claims.sub!==subject)throw Error(label+' 身份验证失败，请重新登录');
  return {subject:claims.sub,label:String(claims.email||claims.name||claims.sub)};
}
export async function callbackListener(a,complete){
  a.verifier=randomBytes(48).toString('base64url');a.nonce=randomBytes(32).toString('base64url');
  const listener=http.createServer(async(req,res)=>{
    const headers={'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'};
    const end=(code,message)=>{res.writeHead(code,headers);res.end(message);};
    try{
      if(req.method!=='GET'||req.headers.host!==`127.0.0.1:${listener.address()?.port}`||req.url.length>8000)return end(400,'登录回调地址无效。');
      const url=new URL(req.url,'http://127.0.0.1');if(url.pathname!=='/auth/callback'||url.searchParams.get('state')!==a.state)return end(400,'登录回调验证失败，请回到工坊重试。');
      if(a.status!=='pending'||a.ctrl.signal.aborted||a.completing)return end(400,'该登录已结束。');
      a.completing=true;await complete(url.searchParams);end(200,'登录已完成，可以关闭此页并回到提示词工坊。');
    }catch(e){if(a.status==='pending'){a.status='failed';a.message=String(e.message||'账号授权未完成，请重新登录。').slice(0,300);}end(400,'登录未完成，请返回提示词工坊查看状态。');}finally{a.completing=false;if(a.status!=='pending'){clearTimeout(a.expiryTimer);listener.close();}}
  });
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});a.listener=listener;
  a.redirectUri=`http://127.0.0.1:${listener.address().port}/auth/callback`;
  return {state:a.state,nonce:a.nonce,response_type:'code',redirect_uri:a.redirectUri,code_challenge_method:'S256',code_challenge:createHash('sha256').update(a.verifier).digest('base64url')};
}
