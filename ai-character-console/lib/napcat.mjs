import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import QRCode from 'qrcode';
import {ApiError,jsonFetch} from './adapters.mjs';

const clean = value => String(value || '').replace(/https?:\/\/\S+/g, '[链接]').slice(0, 400);
export class NapcatAdapter {
  constructor({baseUrl=process.env.NAPCAT_WEBUI_URL||'http://127.0.0.1:6099',credentialFile=process.env.NAPCAT_CREDENTIAL_FILE||(process.env.CREDENTIALS_DIRECTORY?join(process.env.CREDENTIALS_DIRECTORY,'napcat-webui'):''),token,fetcher=jsonFetch}={}) {
    this.base=baseUrl.replace(/\/$/,'')+'/api';this.file=credentialFile;this.token=token;this.fetcher=fetcher;this.credential=null;this.authenticating=null;this.credentialUntil=0;this.authRetryAfter=0;this.authError='';
  }
  get configured(){return !!(this.token||this.file);}
  async authenticate(){
    if(this.credential&&this.credentialUntil>Date.now())return this.credential;
    if(this.authenticating)return this.authenticating;
    if(Date.now()<this.authRetryAfter)throw new ApiError(this.authError||'网关管理连接稍后重试',503);
    this.authenticating=(async()=>{
      let token=this.token;
      if(!token){try{token=JSON.parse(await readFile(this.file,'utf8')).token;}catch{throw new ApiError('QQ 网关管理凭据不可用，请检查服务配置',503);}}
      if(!token)throw new ApiError('尚未配置 QQ 网关管理连接',503);
      const result=await this.fetcher(this.base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hash:createHash('sha256').update(token+'.napcat').digest('hex')})});
      if(result.data?.require2FA)throw new ApiError('网关管理启用了二次验证，请在原网关页面完成验证',409);
      if(result.code!==0||!result.data?.Credential)throw new ApiError('QQ 网关管理凭据已失效，请检查配置',502);
      this.credential=result.data.Credential;this.credentialUntil=Date.now()+50*60000;return this.credential;
    })();
    try{const credential=await this.authenticating;this.authRetryAfter=0;return credential;}catch(error){this.authRetryAfter=Date.now()+60000;this.authError=error.message;throw error;}finally{this.authenticating=null;}
  }
  async call(path,body={}){
    const credential=await this.authenticate();
    const r=await this.fetcher(this.base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify(body)});
    if(r.code!==0){if(/Unauthorized|Authorization|token is invalid/i.test(r.message||'')){this.credential=null;this.credentialUntil=0;}throw new ApiError(clean(r.message)||'QQ 网关未完成操作',502);}
    return r.data;
  }
  async inspect(expectedAccount){
    const raw=await this.call('/QQLogin/CheckLoginStatus');
    let account='';
    if(raw.isLogin&&raw.coreReady){const info=await this.call('/QQLogin/GetQQLoginInfo');account=String(info?.uin||info?.user_id||'');}
    return {raw,state:{available:true,phase:raw.loginPhase||'unknown',isLogin:!!raw.isLogin,coreReady:!!raw.coreReady,qrLoginAccepted:!!raw.qrLoginAccepted,account,expectedAccount,wrongAccount:!!account&&account!==String(expectedAccount),error:clean(raw.loginError),checkedAt:new Date().toISOString()}};
  }
  async status(expectedAccount){try{return (await this.inspect(expectedAccount)).state;}catch(e){return {available:false,phase:'unavailable',isLogin:false,coreReady:false,expectedAccount,error:clean(e.message),checkedAt:new Date().toISOString()};}}
  async qr(expectedAccount,{refresh=false}={}){
    const {raw,state}=await this.inspect(expectedAccount);
    if(state.isLogin||state.qrLoginAccepted||['qrcode_scanned','initializing','reconnecting'].includes(state.phase))return {state,image:null};
    let url=raw.qrcodeurl;
    if(refresh||!url){const updated=await this.call('/QQLogin/RefreshQRcode');url=updated?.qrcodeurl||(await this.inspect(expectedAccount)).raw.qrcodeurl;}
    if(typeof url!=='string'||!url||url.length>3000)throw new ApiError('二维码尚未生成，请稍后刷新',502);
    // Encode the current ticket from the API, rather than copying a possibly stale image file.
    const image=await QRCode.toDataURL(url,{width:280,margin:3,errorCorrectionLevel:'M'});
    return {state,image,refreshAfterMs:35000,createdAt:new Date().toISOString()};
  }
}
