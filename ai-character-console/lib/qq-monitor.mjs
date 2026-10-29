export function createQqMonitor({napcat,dsh,store,now=Date.now,characterId='dafeiyu'}){
  let running=false,stopped=false,previous='',nextReconnect=0;
  async function check(){
    if(stopped||running||!napcat.configured)return;
    running=true;
    try{
      const character=store.get(characterId);if(!character)return;
      const [qq,runtime]=await Promise.all([napcat.status(character.qqAccount),dsh.state(true)]);
      if(stopped)return;
      const connected=runtime.qqState==='connected'&&runtime.account===character.qqAccount;
      const key=!qq.available?'management-unavailable':qq.wrongAccount?'wrong-account':!qq.isLogin||!qq.coreReady?'login-required':connected?'online':'reconnect-required';
      if(key!==previous){
        const messages={'management-unavailable':'QQ 网关管理暂不可用','wrong-account':'QQ 登录账号不匹配','login-required':'QQ 需要扫码登录','online':'QQ 与 DSH 连接正常','reconnect-required':'QQ 已登录，DSH 等待重连'};
        store.audit(character.id,messages[key]);previous=key;
      }
      if(key==='reconnect-required'&&runtime.enabled!==false&&now()>=nextReconnect){
        nextReconnect=now()+30000;
        try{await dsh.reconnect();if(!stopped)store.audit(character.id,'已尝试自动重连 QQ 网关');}
        catch{if(!stopped)store.audit(character.id,'QQ 自动重连失败','稍后重试，可在 QQ 连接页手动检查');}
      }
      return {qq,runtime};
    }finally{running=false;}
  }
  return {check,stop(){stopped=true;}};
}
