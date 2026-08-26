import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.trim().startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sb=createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
// Debits since the logo change on 24-Aug, which SHOULD each have pushed.
const {data}=await sb.from("transactions")
  .select("id,type,amount,payee,status,is_transfer,currency,categories(counts_as_spend,name),raw_messages(phone_received_at)")
  .eq("type","debit").gte("transaction_date","2026-08-22").order("id",{ascending:false});
console.log("debits since 22-Aug that should each have fired a budget push:");
for(const t of data){
  const q = t.status==="success" && !t.is_transfer && t.currency==="INR" &&
            (t.categories==null || t.categories.counts_as_spend===true);
  console.log(`  id=${t.id} ₹${t.amount} ${t.payee ?? ""} -> ${q?"SHOULD have pushed":"correctly silent"}`);
}
console.log(`\nsubscription created 2026-07-28; the PWA was reinstalled on 24-Aug for the new icon.`);
