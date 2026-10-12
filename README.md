# MISTI — helyi, ZDR-kompatibilis AI chat

Böngészőből használható, a saját gépen futó chatfelület a Mistral EU-s API-jához.
Általános chatre és dokumentumok (.docx, .pdf) valamint képek elemzésére való,
**Zero Data Retention (ZDR)** mellett: a Mistral nem tárolja és nem naplózza
sem a kérdéseket, sem a válaszokat.

## 1. Futtatás

**Előfeltételek**

- [Bun](https://bun.sh)
- Mistral API-kulcs olyan fiókhoz, amelyen a Mistral **jóváhagyta a ZDR-t**
  (jóváhagyás után az Admin felület adatvédelmi beállításainál látszik;
  igényelni a Mistral supportnál kell).

**Indítás**

```sh
cp .env.example .env        # majd a .env-ben: MISTRAL_API_KEY=...
bun install
bun server.ts
```

Ezután böngészőben: <http://127.0.0.1:31571>

- A szerver csak a saját gépről érhető el (`127.0.0.1`), más gépről nem.
- Fájlok: húzd az ablakba, vagy „+ Attach”; képernyőkép: Ctrl+V.
- „New chat” vagy oldalfrissítés = tiszta lap; a beszélgetés sehol nem marad meg.
- A költség forintban látszik (becslés); fölé húzva az egeret a USD-összeg és
  az árfolyam is megjelenik.

**Céges hálózat, proxy**

- Proxy esetén: `HTTPS_PROXY=http://proxy.ceg:8080` a `.env`-ben.
- Ha a cég TLS-forgalmat vizsgál (tanúsítványhiba az indítás után):
  `NODE_EXTRA_CA_CERTS=C:\út\a\ceges-root-ca.pem`.
- A **Healthcheck** gomb próbahívással ellenőrzi a kapcsolatot (pl. VPN-váltás után).
- Hiba esetén a konzol részletes, de tartalommentes naplót ír — ezt kell
  továbbítani hibabejelentéskor.

Tesztek: `bun test` (hálózat és API-kulcs nélkül fut).

## 2. Miért ez a legjobb megoldás ZDR és EU szempontból?

### Európai szolgáltató, közvetlenül

- A **Mistral AI francia, európai székhelyű cég**; a MISTI az EU-s végpontot
  (`api.eu.mistral.ai`) hívja, közvetlenül, felhőszolgáltató-közvetítő nélkül.
- Az amerikai szolgáltatók (OpenAI, Anthropic, Google) EU-s adatkezelést is
  kínálnak, de amerikai anyavállalatként esetükben az EU-s adattárolás mellett is
  felmerül az amerikai hatósági hozzáférés (pl. US CLOUD Act) kérdése, és az EU-s
  feldolgozás gyakran további szereplőn (AWS, Google Cloud) keresztül valósul meg.
  A Mistralnál egyetlen, európai szerződő fél van (az általa igénybe vett
  alvállalkozókat a Mistral Trust Center listázza).

### ZDR: csak az arra jogosult végpontok

A Mistral ZDR-je is **csak „állapotmentes” (stateless) API-hívásokra** vonatkozik;
a tárolással járó funkciókra (Agents, Batch, Conversations, Libraries,
`/v1/files`, a Le Chat termék) **nem**. A MISTI ezért szigorúan csak ezeket használja:

- `/v1/chat/completions` — a beszélgetés, és
- `/v1/models` — kapcsolatellenőrzés.

A dokumentumokat **sosem tölti fel** a Mistralhoz fájlként: a szöveget a saját
gépen nyeri ki, és csak a szöveg megy a kérésben. A képek is a kérésen belül
(beágyazva) utaznak, nem külön tárolt fájlként.

### Semmi nem marad meg — nálunk sem

- A szerver **nem ír lemezre** dokumentumot, és nem tárol beszélgetést; az
  előzmények csak a böngészőfül memóriájában élnek.
- A napló **soha** nem tartalmaz API-kulcsot, dokumentumszöveget, fájlnevet,
  kérdést, választ vagy képet — csak méreteket, időket, hibakódokat. Ezt
  automatikus teszt ellenőrzi.
- Csak a helyi gépről érhető el, és véd a böngészőn keresztüli visszaélések ellen
  (idegen weboldal nem tudja a nevünkben hívni).

### Fogyasztói szinten nincs ZDR más módon

A népszerű chatalkalmazások (ChatGPT, Claude.ai, Gemini, sőt a Mistral saját
Le Chat-je) fogyasztói formában **nem kínálnak ZDR-t**; ZDR mindenhol csak
API-szinten, külön jóváhagyással érhető el. Fejlesztői API-t viszont munkatárs
nem tud kényelmesen használni. **A MISTI pontosan ezt a rést tölti be:**
megszokott chatfelület, a ZDR-es API fölött.

### Átláthatóság: mi megy még ki a gépről?

Indításkor két **tartalommentes** lekérdezés: a modell árai
([models.dev](https://models.dev)) és az USD/HUF árfolyam (EKB, a
[frankfurter.dev](https://frankfurter.dev) szolgáltatáson át). Ezek semmilyen
felhasználói adatot nem tartalmaznak; ha nem elérhetők, beépített értékekkel
fut tovább.

### Korlátok

- A ZDR a **Mistral-fiók beállítása**, nem a MISTI-é: jóváhagyott ZDR nélkül a
  Mistral (a szolgáltatás alapbeállításai szerint) visszaélés-figyelés céljából
  ideiglenesen megőrizheti a kéréseket. ZDR-el még erre sem tárolja őket.
- A rövid ideig (pár perc) tartó prompt-gyorsítótár (cache) a Mistral oldalán a
  feldolgozás része; a részletekről a Mistral Trust Center ad tájékoztatást.
- A szkennelt (szövegréteg nélküli) PDF-eket a mostani verzió nem kezeli.

## Források

- Mistral — Zero data retention:
  <https://docs.mistral.ai/admin/monitor-comply/zero-data-retention>
- Mistral — Prompt caching:
  <https://docs.mistral.ai/studio/conversations/advanced/prompt-caching>
- OpenAI — Data residency in Europe:
  <https://openai.com/index/introducing-data-residency-in-europe/>
- Anthropic — API and data retention:
  <https://platform.claude.com/docs/en/manage-claude/api-and-data-retention>
