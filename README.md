# VaultBoard

Password & expiry dashboard  
(Cloudflare Workers + KV + Pages)

Owner: **Thiha Aung (Yone Man)**

---

## 0. Screenshot

VaultBoard UI screenshot 👇

![VaultBoard dashboard](dashboard.png)
---

## 1. Project Overview

**VaultBoard** က password / account တွေကို  
- Start date, End date  
- Unlimited / Expiring status  
- Expire လာပြီလား, သုံးပြီးကြာတယ်လား (day(s) used / left)  

ဒီလိုနဲ့ စာရင်းဇယားပုံစံလှလှလေးနဲ့ စီမံခန့်ခွဲနိုင်အောင် တိုးတက်အောင်လုပ်ထားတဲ့ dashboard ဖြစ်ပါတယ်။

Tech stack:

- Cloudflare **Workers** + **KV** (data store)
- Cloudflare **Pages** (UI serve)
- Plain HTML + CSS + JS (no framework)

---

## 2. Cloudflare Setup Summary

### 2.1 KV Store & Env Summary

| Item          | Value / Example       | Note |
| ------------- | --------------------- | ---- |
| **KV Namespace** | `vaultboard_kv`       | Cloudflare Dashboard → KV → Create namespace |
| **Binding name** | `VAULT`               | `_worker.js` code ထဲမှာသုံးထားတဲ့ binding name. Pages project → Settings → Functions → KV bindings မှာ ဒီနာမည်နဲ့ ချိတ်ပါ |
| **Env variable** | `ADMIN_PASSWORD`      | Login လုပ်ချင်တဲ့ admin password. Pages → Settings → Environment variables မှာ ထည့်မယ် |
| **Cookie name**  | `sess`               | Worker.js ထဲမှာ hard-coded session cookie name (`sess`) |
| **KV keys**      | `sess:*`, `index:*`, `rec:*` | Session, index, record data တွေသိမ်းတဲ့ key pattern တွေ |

---

## 3. Repo Structure

GitHub repo ကို အောက်ကလို structure နဲ့ သတ်မှတ်ထားပါတယ်။

```text
vaultboard/
├─ _worker.js   # main Cloudflare Worker + UI code
└─ README.md    # ဒီ guide ဖိုင်
