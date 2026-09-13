import subprocess, re

# 1. goalEngine.ts ve GoalEnginePanel.tsx yollarını bul
engine_file = subprocess.check_output(["find", ".", "-name", "goalEngine.ts"]).decode().strip().split("\n")[0]
panel_file = subprocess.check_output(["find", ".", "-name", "GoalEnginePanel.tsx"]).decode().strip().split("\n")[0]

print(f"[*] Hedef Engine: {engine_file}")
print(f"[*] Hedef Panel : {panel_file}")

# 2. Engine Güncelleme
with open(engine_file, "r") as f:
    code = f.read()

# Tip ekle
if '"SOLO_HOLLOW_TRAP"' not in code:
    code = code.replace('"HIGH_TOTAL_LADDER";', '"HIGH_TOTAL_LADDER"\n  | "SOLO_HOLLOW_TRAP";')

# Merdiveni daralt (OU 4.5 <= 3.20 tabanı şartı)
old_ladder = r'const LADDER_CS = \["4:3", "3:4", "4:2", "5:4", "5:2"\];.*?if \(!matchedCase && ladderFlags >= 2\) \{'
new_ladder = """const LADDER_CS = ["4:3", "3:4", "4:2", "5:4", "5:2"];
  const ladderCsHits = LADDER_CS.filter((s) => highScoreDrops.has(s)).length;
  
  const isLadderBaseOk = Boolean(ou45Eff != null && ou45Eff <= 3.20);
  const hasLadderUnderLeak = Boolean(ou25UnderDrift >= 1.10);
  const hasLadder55Steam = Boolean(ou55OverDrift <= 0.88);
  const hasLadderExotic = ladderCsHits >= 1;

  if (!matchedCase && isLadderBaseOk && (hasLadderUnderLeak || hasLadder55Steam || hasLadderExotic)) {"""

code, _ = re.subn(old_ladder, new_ladder, code, flags=re.DOTALL)

# Solo Hollow Trap vakası ekle
if "isSoloHollowTrap" not in code:
    hollow_code = """
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
    anchor = "if (matchedCase) {\n    anomalies.unshift(`🧠 MEMORY MATCH:"
    if anchor in code:
        code = code.replace(anchor, hollow_code + "\n  " + anchor)

# Case fair lines ekle
if "SOLO_HOLLOW_TRAP: 1.75" not in code:
    code = code.replace("HIGH_TOTAL_LADDER: 5.5,", "HIGH_TOTAL_LADDER: 5.5,\n      SOLO_HOLLOW_TRAP: 1.75,")

# Multiplier ekle
if 'scoreProfile === "SOLO_HOLLOW_TRAP"' not in code:
    mult = """if (scoreProfile === "SOLO_HOLLOW_TRAP") {
      if (totG === 0) return 1.65;
      if (rawFavGoals === 1 && rawDogGoals === 0) return 1.5;
      if (rawFavGoals === 2 && rawDogGoals === 0) return 1.35;
      if (rawDogGoals >= 1) return 0.25;
      if (totG >= 4) return 0.2;
      return 0.75;
    }
    """
    code = code.replace("const totG = hG + aG;\n", "const totG = hG + aG;\n    " + mult)

with open(engine_file, "w") as f:
    f.write(code)
print("[+] Engine dosyası başarıyla güncellendi.")

# 3. Panel Güncelleme
with open(panel_file, "r") as f:
    p_code = f.read()

if "SOLO_HOLLOW_TRAP" not in p_code:
    p_code = p_code.replace(
        'HIGH_TOTAL_LADDER: "High Total Ladder (6+ / HT Over 2.5 family)",',
        'HIGH_TOTAL_LADDER: "High Total Ladder (6+ / HT Over 2.5 family)",\n  SOLO_HOLLOW_TRAP: "Heerenveen (Asymmetric Hollow Solo Surge Trap)",'
    )
    with open(panel_file, "w") as f:
        f.write(p_code)
    print("[+] Panel dosyası başarıyla güncellendi.")

