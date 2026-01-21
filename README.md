# VaultBoard

Password & expiry dashboard (Cloudflare Pages + KV)  
Owner: **Thiha Aung (Yone Man)**

---

## 1. Overview

VaultBoard က

- Password / Account တွေကို တစ်နေရာတည်း စုသိမ်းပြီး
- Start date / End date / Unlimited usage
- ဘယ်နေ့ကတည်းကသုံးနေလဲ, ဘယ်လောက်နေ့ကျန်သေးလဲ
- Expiring / Expired ကို UI ထဲက status နဲ့ အလွယ်တကူ ကြည့်လို့ရဖို့

အတွက် single-user dashboard တစ်ခု ဖြစ်ပါတယ်။  
Backend က **Cloudflare Pages (Advanced: _worker.js)** နဲ့ **KV Store** နဲ့သာ run လုပ်တယ်။

---

## 2. Cloudflare Setup Summary

### 2.1 KV Store & Env Summary

Cloudflare Dashboard ထဲမှာ လိုအပ်တဲ့ setup တွေကို အောက်ကဇယားတစ်ပုံလောက်နဲ့ သတ်မှတ်ထားပါတယ်။

| Item (အမျိုးအစား) | Value / Example | Note (ရှင်းလင်းချက်) |
| --- | --- | --- |
| **KV Namespace** | `vaultboard_kv` | Cloudflare Dashboard → **Storage & Databases → KV** → Create namespace |
| **Binding name** | `VAULT` | Pages project → **Settings → Functions → KV namespace bindings** ထဲမှာ Variable name အနေနဲ့ သတ်မှတ်ထားရမယ် |
| **Env variable** | `ADMIN_PASSWORD` | Dashboard ထဲ login ဝင်ရမယ့် admin password ကို Env var အနေနဲ့သတ်မှတ် (`Settings → Environment variables`) |
| **Cookie name** | `sess` | Worker က session ကို သိမ်းဖို့ သုံးတဲ့ cookie name (`sess=...`) |
| **KV keys** | `sess:*`, `index:*`, `rec:*` | `sess:*` = session, `index:*` = record index list, `rec:*` = record data (password rows) |

---

## 3. GitHub Repo Structure

GitHub repo ကို အောက်ပါလို တိုတောင်းတဲ့ structure နဲ့ သတ်မှတ်ထားတယ်။

```text
vaultboard/
 ├─ _worker.js   # Cloudflare Pages / Worker main code
 └─ README.md    # ဒီ guide
