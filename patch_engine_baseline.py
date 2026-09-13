import re, subprocess

# 1. goal_anomaly_cli.py güncelleme
with open("goal_anomaly_cli.py", "r") as f:
    cli_code = f.read()

cli_target = r'(p25 >= 58\.0 and\s*\(ou45_o is None or ou45_o >= 2\.50\))'
cli_replacement = """not any(x in f"{row['home_name']} {row['away_name']}".lower() for x in [" u21", " u19", " u20", " u23", " (w)", " w ", " women", " ii", " 2", " b "]) and
    (ou25_o is None or (ou25_o > 1.55)) and
    \\1"""

if "ou25_o > 1.55" not in cli_code:
    cli_code = re.sub(cli_target, cli_replacement, cli_code)
    with open("goal_anomaly_cli.py", "w") as f:
        f.write(cli_code)
    print("[+] goal_anomaly_cli.py güncellendi.")

# 2. goalEngine.ts güncelleme
engine_file = subprocess.check_output(["find", ".", "-name", "goalEngine.ts"]).decode().strip().split("\n")[0]
with open(engine_file, "r") as f:
    web_code = f.read()

web_target = r'const isStaticRetailBait = Boolean\(\s*!isOrganicLadder &&\s*!isAsymmetricChoke &&'
web_replacement = """const isHighBaselineOpening = (ou25Eff != null && ou25Eff <= 1.55);
  const isYouthOrReserve = /u19|u20|u21|u23|reserve|\\bii\\b|\\b2\\b|\\bw\\b|women|\\bb\\b/i.test(`${homeTeam} ${awayTeam}`);

  const isStaticRetailBait = Boolean(
    !isOrganicLadder &&
    !isAsymmetricChoke &&
    !isHighBaselineOpening &&
    !isYouthOrReserve &&"""

if "isHighBaselineOpening" not in web_code:
    web_code = re.sub(web_target, web_replacement, web_code)
    with open(engine_file, "w") as f:
        f.write(web_code)
    print("[+] goalEngine.ts güncellendi.")

