"""On-demand outbound trolley worker. Drains this queue, then exits; no web server."""
from __future__ import annotations
import argparse,os,sys,time
from pathlib import Path
from dotenv import load_dotenv
from .render_client import RenderClient
from .llm_client import LocalLlmClient
from .worker import GenerationLock,DEFAULT_GENERATION_LOCK_PATH
from . import lgent_dispatch


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--once',action='store_true',help='process at most one photo')
    parser.add_argument('--env-file',type=Path,default=Path(__file__).with_name('.env'))
    args=parser.parse_args();load_dotenv(args.env_file)
    base=os.getenv('RENDER_API_BASE_URL','').rstrip('/')
    token=os.getenv('AI_WORKER_TOKEN','')
    if not base.startswith('https://') or not token:
        print('Existing HTTPS Render worker configuration is required.',file=sys.stderr);return 2
    name=lgent_dispatch.lgent_name(os.getenv('WORKER_NAME','mac-studio'))
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
                lgent_dispatch.heartbeat(client,name,True)
                if not lgent_dispatch.process_one(client,llm,name):break
                processed+=1
            finally:gate.release()
            if args.once:break
    finally:
        try:lgent_dispatch.heartbeat(client,name,False)
        except Exception:pass
    print(f'Finished {processed} photo jobs. Worker stopped.');return 0

if __name__=='__main__':raise SystemExit(main())
