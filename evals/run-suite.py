"""Run complete gateway conversations; only model calls leave the local fixtures."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import uuid

PHASES = ['public_routing', 'open_correction', 'work_overview', 'semantic_payment',
          'alder_reconciliation', 'alder_earnings', 'alder_private_noise',
          'alder_group_delivery', 'private_notice_failure', 'tool_protocol',
          'group_failure', 'clock_confirmation', 'new_group', 'reuse_group',
          'group_conflict', 'onboarding_delivery', 'dashboard', 'group_attention', 'full']
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', required=True)
parser.add_argument('--output', type=Path, required=True)
parser.add_argument('--phases', nargs='+', choices=PHASES, default=PHASES)
args = parser.parse_args()
if not os.environ.get('PLOW_AGENT_TOKEN'):
    parser.error('Set PLOW_AGENT_TOKEN for real model requests.')
image = subprocess.check_output(['docker', 'image', 'inspect', args.image,
                                 '--format', '{{.Id}}'], text=True).strip()
retained_image = "plow-hours:e2e-" + uuid.uuid4().hex
subprocess.run(["docker", "tag", image, retained_image], check=True)
root = Path(__file__).resolve().parent
args.output = args.output.resolve()
args.output.mkdir(parents=True, exist_ok=True)

def run(phase):
    output = args.output / phase
    output.mkdir(exist_ok=True)
    with (output / 'run.log').open('w') as log:
        result = subprocess.run(['docker', 'run', '--rm', '--user', 'root',
            '--entrypoint', 'node', '-e', 'PLOW_AGENT_TOKEN', '-e', f'EVAL_PHASE={phase}',
            '-e', 'EVAL_LOG=1', '-e', 'EVAL_OUTPUT=/evidence',
            '-v', f'{root}:/opt/plow/evals:ro', '-v', f'{output}:/evidence',
            image, '/opt/plow/evals/conversation.mjs'], stdout=log, stderr=subprocess.STDOUT)
    evidence = output / 'conversation.json'
    data = json.loads(evidence.read_text()) if evidence.exists() else {}
    checks = data.get('checks', [])
    passed = result.returncode == 0 and bool(checks) and all(c['passed'] for c in checks)
    row = dict(phase=phase, passed=passed, exit_code=result.returncode,
               checks=len(checks), turns=len(data.get('turns', [])), image=image)
    print(json.dumps(row), flush=True)
    return row

try:
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run, args.phases))
finally:
    subprocess.run(["docker", "image", "rm", retained_image], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
(args.output / 'suite.json').write_text(json.dumps(results, indent=2) + '\n')
raise SystemExit(0 if all(row['passed'] for row in results) else 1)
