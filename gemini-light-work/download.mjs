import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP,BlockList} from 'node:net';
const denied=new BlockList();for(const [a,p]of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['192.0.0.0',24],['192.0.2.0',24],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])denied.addSubnet(a,p);
export const publicV4=a=>isIP(a)===4&&!denied.check(a,'ipv4');
export async function download(raw,max=12*1024*1024){
 const u=new URL(raw);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port))throw Error('文件下载地址无效');
 const addresses=await lookup(u.hostname,{all:true,family:4});if(!addresses.length||addresses.some(a=>!publicV4(a.address)))throw Error('不允许访问本机或内网文件地址');
 return new Promise((resolve,reject)=>{const req=(u.protocol==='https:'?https:http).get(u,{lookup:(_h,_o,cb)=>cb(null,addresses[0].address,4)},r=>{
 if(r.statusCode!==200){r.resume();reject(Error('QQ文件下载失败，请重新上传或检查文件是否过期'));return;}
 let size=0;const chunks=[];r.on('data',b=>{size+=b.length;if(size>max){r.destroy(Error('文件超过12MB限制'));return;}chunks.push(b)});r.on('error',reject);r.on('end',()=>resolve(Buffer.concat(chunks)));
 });const timer=setTimeout(()=>req.destroy(Error('文件下载超时')),20000);req.on('close',()=>clearTimeout(timer));req.on('error',reject);});
}
