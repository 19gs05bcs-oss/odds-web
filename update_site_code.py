import os, re

engine_paths = [
    "lib/analysis/goalEngine.ts",
    "src/lib/analysis/goalEngine.ts",
    "artifacts/goalEngine.ts"
]

target_file = None
for p in engine_paths:
    if os.path.exists(p):
        target_file = p
        break

if not target_file:
    print("[-] goalEngine.ts bulunamadı. Lütfen proje ana dizininde olduğunuzdan emin olun.")
    exit(1)

with open(target_file, "r") as f:
    content = f.read()

# 1. ScoreProfile tipine SOLO_HOLLOW_TRAP ekleme
if "SOLO_HOLLOW_TRAP" not in content:
    content = content.replace(
        '"HIGH_TOTAL_LADDER";',
        '"HIGH_TOTAL_LADDER"\n  | "SOLO_HOLLOW_TRAP";'
    )

# 2. Merdiven filtresini sıkı kalibrasyona çekme (OU 4.5 <= 3.20 zorunluluğu)
old_ladder_pattern = r'const LADDER_CS = \["4:3", "3:4", "4:2", "5:4", "5:2"\];.*?if \(!matchedCase && ladderFlags >= 2\) \{'
new_ladder_block = """const LADDER_CS = ["4:3", "3:4", "4:2", "5:4", "5:2"];
  const ladderCsHits = LADDER_CS.filter((s) => highScoreDrops.has(s)).length;
  
  // Kalibre Edilmiş Sıkı Taban: OU 4.5 kesinlikle <= 3.20 olmalı (Man Utd tuzağını önler)
  const isLadderBaseOk = Boolean(ou45Eff != null && ou45Eff <= 3.20);
  const hasLadderUnderLeak = Boolean(ou25UnderDrift >= 1.10);
  const hasLadder55Steam = Boolean(ou55OverDrift <= 0.88);
  const hasLadderExotic = ladderCsHits >= 1;

  if (!matchedCase && isLadderBaseOk && (hasLadderUnderLeak || hasLadder55Steam || hasLadderExotic)) {"""

content, count_ladder = re.subn(old_ladder_pattern, new_ladder_block, content, flags=re.DOTALL)

# 3. Solo Hollow Trap (Heerenveen Asimetrik Boşluk Tuzağı) ekleme
if "isSoloHollowTrap" not in content:
    hollow_block = """
  // --- VAKA: SOLO HOLLOW TRAP (Heerenveen Asymmetric Model) ---
  const isSoloHollowTrap = Boolean(
    !matchedCase &&
    rawFavSide === "H" &&
    p25 >= 0.62 &&
    (isUnderLeaking || hasFavHandicapSmash) &&
    bttsDrift >= 0.97 &&
    !hasDogHandicapSupport &&
    (sc01 == null || sc01 >= 14.0) &&
    (sc02 == null || sc02 >= 20.0)
  );

  if (isSoloHollowTrap) {
    matchedCase = {
      name: "HEERENVEEN MODEL (Asymmetric Hollow Solo Surge Trap)",
      desc: "Total Over line looks heavily backed and favorite handicap collapsed, but the opponent's attacking output is completely dead in the market! High risk of an asymmetric 0-0 or 1-0 lock if the favorite struggles.",
      ht: "BALANCED FIRST HALF (0-0 / 1-0 Single-Team Domination)",
      ft: "⚠️ ASYMMETRIC ONE-SIDED PRESSURE (Hollow Over Trap / 0-0 Lock Threat If Unconverted)",
      team: "⛔ AVOID FULL TIME GENERAL OVER (Opponent contribution dead; Home Win / Home Solo Over 1.5 only)",
      profile: "SOLO_HOLLOW_TRAP",
    };
  }
"""
    anchor = 'if (matchedCase) {\n    anomalies.unshift(`🧠 MEMORY MATCH:'
    if anchor in content:
        content = content.replace(anchor, hollow_block + "\n  " + anchor)

# 4. CASE_FAIR_LINES ve getScoreMultiplier içine SOLO_HOLLOW_TRAP ekleme
if "SOLO_HOLLOW_TRAP: 1.75" not in content:
    content = content.replace(
        "HIGH_TOTAL_LADDER: 5.5,",
        "HIGH_TOTAL_LADDER: 5.5,\n      SOLO_HOLLOW_TRAP: 1.75,"
    )

if 'scoreProfile === "SOLO_HOLLOW_TRAP"' not in content:
    mult_code = """if (scoreProfile === "SOLO_HOLLOW_TRAP") {
      if (totG === 0) return 1.65;
      if (rawFavGoals === 1 && rawDogGoals === 0) return 1.5;
      if (rawFavGoals === 2 && rawDogGoals === 0) return 1.35;
      if (rawDogGoals >= 1) return 0.25;
      if (totG >= 4) return 0.2;
      return 0.75;
    }
    """
    content = content.replace('const getScoreMultiplier = (hG: number, aG: number): number => {\n    const totG = hG + aG;', 'const getScoreMultiplier = (hG: number, aG: number): number => {\n    const totG = hG + aG;\n    ' + mult_code)

with open(target_file, "w") as f:
    f.write(content)

print(f"[+] {target_file} başarıyla güncellendi.")

# Panel etiketini kontrol edip güncelleme
panel_paths = [
    "components/GoalEnginePanel.tsx",
    "src/components/GoalEnginePanel.tsx",
    "components/analysis/GoalEnginePanel.tsx"
]
for p in panel_paths:
    if os.path.exists(p):
        with open(p, "r") as pf:
            p_content = pf.read()
        if "SOLO_HOLLOW_TRAP" not in p_content:
            p_content = p_content.replace(
                'HIGH_TOTAL_LADDER: "High Total Ladder (6+ / HT Over 2.5 family)",',
                'HIGH_TOTAL_LADDER: "High Total Ladder (6+ / HT Over 2.5 family)",\n  SOLO_HOLLOW_TRAP: "Heerenveen (Asymmetric Hollow Solo Surge Trap)",'
            )
            with open(p, "w") as pf:
                pf.write(p_content)
            print(f"[+] {p} panel etiketi güncellendi.")
