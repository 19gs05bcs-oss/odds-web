import subprocess, re

engine_file = subprocess.check_output(["find", ".", "-name", "goalEngine.ts"]).decode().strip().split("\n")[0]
print(f"[*] Hedef goalEngine: {engine_file}")

with open(engine_file, "r") as f:
    code = f.read()

# 1. ScoreProfile tiplerine ASYMMETRIC_CHOKE ve STATIC_RETAIL_BAIT ekleme
if "ASYMMETRIC_CHOKE" not in code:
    code = code.replace(
        '"HIGH_TOTAL_LADDER"',
        '"HIGH_TOTAL_LADDER"\n  | "ASYMMETRIC_CHOKE"\n  | "STATIC_RETAIL_BAIT"'
    )

# 2. Merdiven ve Rejim bloğunu güncelle
old_ladder_block = r'const LADDER_CS = \["4:3", "3:4", "4:2", "5:4", "5:2"\];.*?if \(!matchedCase && isLadderBaseOk && \(hasLadderUnderLeak \|\| hasLadder55Steam \|\| hasLadderExotic\)\) \{.*?\};?\s*\}'

new_regime_block = """// --- 3 ANA PİYASA REJİMİ MOTORU ---
  const isOrganicLadder = Boolean(
    ou45Eff != null && ou45Eff <= 2.25 &&
    (medHt00 != null && medHt00 >= 5.00) &&
    (medBttsYes != null && medBttsYes <= 1.35) &&
    (ou25UnderDrift >= 1.15 || ou55OverDrift <= 0.88)
  );

  const isAsymmetricChoke = Boolean(
    !isOrganicLadder &&
    handicapSmashCount >= 3 &&
    medBttsYes != null && medBttsYes >= 1.45 &&
    rawFavOdds != null && rawFavOdds <= 1.80
  );

  const isStaticRetailBait = Boolean(
    !isOrganicLadder &&
    !isAsymmetricChoke &&
    p25 >= 0.58 &&
    (ou45Eff == null || ou45Eff >= 2.50) &&
    (medHt00 != null && medHt00 <= 4.50) &&
    (!isUnderLeaking || ou25UnderDrift <= 1.02)
  );

  if (!matchedCase && isOrganicLadder) {
    matchedCase = {
      name: "ORGANIC HIGH TOTAL LADDER (Doğal 5+ Gol Patlaması)",
      desc: "Doğal barem zaten 4.5+ seviyesinde ve ilk yarı 0-0 ihtimali tamamen silinmiş. 4.5 / 5.5 Üst doğal koridorda.",
      ht: "🔥 FIRST HALF TEMPO (Erken Gol Yağmuru / HT 0.5 & 1.5 Over)",
      ft: "🎯 ORGANIC HIGH TOTAL LADDER (4.5 / 5.5 Üst Diri — 5+ Gol Beklentisi)",
      team: "✅ 4.5 / 5.5 Üst Doğal Koridor (İki takım da yüksek tempoda)",
      profile: "HIGH_TOTAL_LADDER",
    };
  } else if (!matchedCase && isAsymmetricChoke) {
    matchedCase = {
      name: "ASYMMETRIC CHOKE TRAP (Heerenveen/PSG Asimetrik Boğma Modeli)",
      desc: "Favori handikapı çöktü ancak deplasman katkısı piyasadan silinmiş. Favori tek başına açamazsa 0-0, 1-0 kilit riski!",
      ht: "BALANCED FIRST HALF (0-0 / 1-0 Single-Team Domination)",
      ft: "⚠️ ASYMMETRIC CHOKE TRAP (Rakip Yok / Kısır Kilit Tehdidi)",
      team: "⛔ AVOID FULL TIME GENERAL OVER (Deplasman katkısı sıfırlandı; Sadece Favori Galibiyeti)",
      profile: "ASYMMETRIC_CHOKE",
    };
  } else if (!matchedCase && isStaticRetailBait) {
    matchedCase = {
      name: "STATIC RETAIL BAIT (Tijuana/Volendam Şablon Vitrin Tuzağı)",
      desc: "Barem açılışta yüksek şablonla sunulmuş fakat ilk yarı 0-0 diri tutuluyor ve piyasa akışı yok. 0-2 gol riski tavan!",
      ht: "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak / Static Bait)",
      ft: "🧊 STATIC RETAIL BAIT (Doğal Taban Düşük / Sahte 2.5 Üst — 0-2 Gol Riski)",
      team: "❌ 2.5 Üst ve KG Var Oynanmaz (Statik vitrin, kurumsal akış yok)",
      profile: "STATIC_RETAIL_BAIT",
    };
  }"""

code = re.sub(old_ladder_block, new_regime_block, code, flags=re.DOTALL)

# 3. Fair lines sözlüğüne yeni profilleri ekleme
if "ASYMMETRIC_CHOKE: 1.75" not in code:
    code = code.replace(
        "HIGH_TOTAL_LADDER: 5.5,",
        "HIGH_TOTAL_LADDER: 5.5,\n      ASYMMETRIC_CHOKE: 1.75,\n      STATIC_RETAIL_BAIT: 1.75,"
    )

# 4. Multiplier içine yeni profilleri ekleme
if 'scoreProfile === "ASYMMETRIC_CHOKE"' not in code:
    mult_block = """if (scoreProfile === "ASYMMETRIC_CHOKE" || scoreProfile === "STATIC_RETAIL_BAIT") {
      if (totG === 0) return 1.65;
      if (totG <= 2) return 1.45;
      if (totG >= 4) return 0.20;
      return 0.80;
    }
    """
    code = code.replace("const totG = hG + aG;\n", "const totG = hG + aG;\n    " + mult_block)

with open(engine_file, "w") as f:
    f.write(code)

print("[+] goalEngine.ts 3 rejimli mimariyle başarıyla eşitlendi.")
