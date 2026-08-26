import webpush from "web-push";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sb=createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
webpush.setVapidDetails(env.VAPID_SUBJECT ?? "mailto:admin@sikka.app", env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
const {data:subs}=await sb.from("push_subscriptions").select("*");
console.log(`subscriptions: ${subs.length}`);
for(const s of subs){
  console.log(`\n  id=${s.id}  created=${s.created_at}`);
  console.log(`  endpoint host: ${new URL(s.endpoint).host}`);
  console.log(`  p256dh len=${(s.p256dh??"").length}  auth len=${(s.auth??"").length}`);
  try{
    const res=await webpush.sendNotification(
      {endpoint:s.endpoint, keys:{p256dh:s.p256dh, auth:s.auth}},
      JSON.stringify({title:"Sikka diagnostic", body:"If you can see this, delivery works.", tag:`diag-${Date.now()}`, url:"/"}));
    console.log(`  -> Apple responded ${res.statusCode} ${res.headers?.["apns-id"]?`apns-id=${res.headers["apns-id"]}`:""}`);
    console.log(`  -> body: ${JSON.stringify(res.body).slice(0,200)}`);
  }catch(e){
    console.log(`  -> FAILED statusCode=${e.statusCode} body=${JSON.stringify(e.body).slice(0,300)}`);
    console.log(`  -> headers: ${JSON.stringify(e.headers).slice(0,300)}`);
  }
}
console.log(`\nVAPID public key in env (first 24): ${(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY??"").slice(0,24)}...`);
console.log(`VAPID subject: ${env.VAPID_SUBJECT}`);
