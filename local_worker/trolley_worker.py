"""On-demand outbound trolley worker. Drains this queue, then exits; no web server."""
from __future__ import annotations
import argparse,os,sys,time
from pathlib import Path
from dotenv import load_dotenv
from .render_client import RenderClient,WORKER_VERSION
from .llm_client import LocalLlmClient
from .worker import GenerationLock,DEFAULT_GENERATION_LOCK_PATH
from . import trolley_recognition


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once',action='store_true',help='process at most one photo')
    parser.add_argument('--env-file',type=Path,default=Path(__file__).with_name('.env'))
    args=parser.parse_args();load_dotenv(args.env_file)
    base=os.getenv('RENDER_API_BASE_URL','').rstrip('/')
    token=os.getenv('AI_WORKER_TOKEN','')
    if not base.startswith('https://') or not token:
        print('Existing HTTPS Render worker configuration is required.',file=sys.stderr);return 2
    name=(os.getenv('WORKER_NAME','mac-studio')[:115]+'-lgent')
    client=RenderClient(base,token)
    llm=LocalLlmClient(base_url=os.getenv('LOCAL_LLM_BASE_URL','http://127.0.0.1:8082/v1'),
                       model=os.getenv('LOCAL_LLM_MODEL','/Users/macstudio_ted/Developer/local-ai/models/Qwen3.8-27B-4bit'))
    gate=GenerationLock(os.getenv('LOCAL_LLM_LOCK_PATH',DEFAULT_GENERATION_LOCK_PATH),wait_seconds=0)
    processed=0
    try:
        while processed<500:
            if not llm.is_ready(timeout=5):
                print('Mac AI is unavailable. Photos remain queued.');return 2
            if not gate.acquire():
                print('Shared AI is busy. No photo job was claimed. Try again later.');return 3
            try:
                client.send_heartbeat(name,llm_enabled=True,llm_ready=True,model_name='Qwen3.8-27B-4bit',
                                       worker_version=WORKER_VERSION,available_model_ids=['qwen38'])
                jobs=client.claim_jobs(name,limit=1,job_types=['lgent_trolley_photo'],available_model_ids=['qwen38'])
                if not jobs:break
                job=jobs[0];stamp=str(job['claimed_at'])
                try:
                    client.start_job(job['id'],worker_name=name,claim_timestamp=stamp)
                    result,prompt=trolley_recognition.analyze(job,client,llm,name)
                    accepted=client.complete_job(job['id'],result,model_name='Qwen3.8-27B-4bit',prompt_version=prompt,worker_name=name,claim_timestamp=stamp)
                    if accepted.get('status')!='completed':raise RuntimeError('Result acceptance was not confirmed.')
                    print(f'Photo job {job["id"]}: analysis returned; LG supplier verification remains on Render.',flush=True)
                except Exception as error:
                    client.fail_job(job['id'],type(error).__name__,worker_name=name,claim_timestamp=stamp)
                    print(f'Photo job {job["id"]}: {type(error).__name__}. No LG write was performed.',file=sys.stderr)
                processed+=1
            finally:gate.release()
            if args.once:break
    finally:
        try:client.send_heartbeat(name,llm_enabled=True,llm_ready=False,model_name='Qwen3.8-27B-4bit',worker_version=WORKER_VERSION,available_model_ids=['qwen38'])
        except Exception:pass
    print(f'Finished {processed} photo jobs. Worker stopped.');return 0

if __name__=='__main__':raise SystemExit(main())
