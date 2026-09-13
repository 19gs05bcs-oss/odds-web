import subprocess, re

engine_file = subprocess.check_output(["find", ".", "-name", "goalEngine.ts"]).decode().strip().split("\n")[0]
print(f"[*] Hedef Dosya: {engine_file}")

with open(engine_file, "r") as f:
    code = f.read()

# 1. Merdiven Eşiği: OU 4.5 <= 3.20 tabanı ve likidite zorunluluğu
old_ladder_re = r'const isLadderBaseOk = .*?if \(!matchedCase && isLadderBaseOk && \(hasLadderUnderLeak \|\| hasLadder55Steam \|\| hasLadderExotic\)\) \{'
new_ladder_block = """const isLadderBaseOk = Boolean(ou45Eff != null && ou45Eff <= 3.20);
  const hasLadderUnderLeak = Boolean(ou25UnderDrift >= 1.10);
  const hasLadder55Steam = Boolean(ou55OverDrift <= 0.88);
  const hasLadderExotic = ladderCsHits >= 1;

  if (!matchedCase && isLadderBaseOk && (hasLadderUnderLeak || hasLadder55Steam || hasLadderExotic)) {"""
code = re.sub(old_ladder_re, new_ladder_block, code, flags=re.DOTALL)

# 2. htVerdict Bloğu: Statik vitrinde ilk yarıyı mutlaka HARD LOCK'a çekme
old_ht_re = r'let htVerdict = "BALANCED FIRST HALF \(0-1 Goal Expectation\)";.*?else if \(htVelocity === "HARD_LOCK"\) \{\s+htVerdict = "🔒 FIRST HALF HARD LOCK \(0:0 Risk at Peak\)";\s+\}'
new_ht_block = """let htVerdict = "BALANCED FIRST HALF (0-1 Goal Expectation)";
  const isStaticHtTrap = Boolean(
    (medHt00 != null && medHt00 >= 3.20) &&
    !isUnderLeaking &&
    (ou25UnderDrift <= 1.01)
  );

  if (isStaticHtTrap || scoreProfile === "STATIC_OVER_TRAP" || isFalseOpen) {
    htVerdict = "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak / Static Bait & 0-1 Goal Corridor)";
  } else if ((pOver25 < 0.48) && (medHtOu05 != null && medHtOu05 <= 1.42) && (medHt00 != null && medHt00 >= 2.60)) {
    htVerdict = "Early first-half strike (Zeledon: HT Over 0.5 / 1.5 live, then the match locks).";
  } else if (isUnderLeaking && (htVelocity === "HIGH_VELOCITY" || (medHtOu05 != null && medHtOu05 <= 1.25))) {
    htVerdict = "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 & 1.5 Over Potential)";
  } else if (htVelocity === "HARD_LOCK") {
    htVerdict = "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak)";
  }"""
code = re.sub(old_ht_re, new_ht_block, code, flags=re.DOTALL)

with open(engine_file, "w") as f:
    f.write(code)

print("[+] goalEngine.ts CLI ile birebir eşitlendi.")
