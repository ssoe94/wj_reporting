"""Claim and analyze LGENT trolley photos for whichever outbound worker polls.

The always-on worker calls `poll` on idle loops, so a photo queued on Render is
picked up within one poll interval; the manual `trolley_worker` command uses the
same code. No LG credentials or LG writes happen here.
"""
from __future__ import annotations

import sys
import time

try:
    from . import trolley_recognition
    from .render_client import WORKER_VERSION
except ImportError:
    import trolley_recognition
    from render_client import WORKER_VERSION

JOB_TYPE = 'lgent_trolley_photo'
MODEL_ID = 'qwen38'
MODEL_NAME = 'Qwen3.8-27B-4bit'
# The LGENT page shows the Mac worker online only for a fresh `-lgent` heartbeat.
SUFFIX = '-lgent'


def lgent_name(worker_name: str) -> str:
    return worker_name[:115] + SUFFIX


def heartbeat(client, name: str, ready: bool) -> None:
    client.send_heartbeat(name, llm_enabled=True, llm_ready=ready, model_name=MODEL_NAME,
                          worker_version=WORKER_VERSION, available_model_ids=[MODEL_ID])


def process_one(client, llm, name: str) -> bool:
    """Claim at most one photo job; returns True when one was claimed."""
    jobs = client.claim_jobs(name, limit=1, job_types=[JOB_TYPE], available_model_ids=[MODEL_ID])
    if not jobs:
        return False
    job = jobs[0]
    stamp = str(job['claimed_at'])
    try:
        client.start_job(job['id'], worker_name=name, claim_timestamp=stamp)
        result, prompt = trolley_recognition.analyze(job, client, llm, name)
        accepted = client.complete_job(job['id'], result, model_name=MODEL_NAME, prompt_version=prompt,
                                       worker_name=name, claim_timestamp=stamp)
        if accepted.get('status') != 'completed':
            raise RuntimeError('Result acceptance was not confirmed.')
        print(f'Photo job {job["id"]}: analysis returned; LG supplier verification remains on Render.', flush=True)
    except Exception as error:
        client.fail_job(job['id'], type(error).__name__, worker_name=name, claim_timestamp=stamp)
        print(f'Photo job {job["id"]}: {type(error).__name__}. No LG write was performed.', file=sys.stderr)
    return True


class Dispatcher:
    """Poll hook for the always-on worker: heartbeat about once a minute, drain
    a few photos per idle loop, and never hold the shared model lock across loops."""

    def __init__(self, client, llm, worker_name: str, generation_lock=None,
                 heartbeat_seconds: float = 60.0, batch: int = 5, clock=time.monotonic):
        self.client = client
        self.llm = llm
        self.name = lgent_name(worker_name)
        self.generation_lock = generation_lock
        self.heartbeat_seconds = heartbeat_seconds
        self.batch = batch
        self.clock = clock
        self.next_heartbeat = 0.0

    def poll(self, ready: bool) -> int:
        now = self.clock()
        if now >= self.next_heartbeat:
            try:
                heartbeat(self.client, self.name, ready)
            except Exception as error:
                print(f'lgent heartbeat failed: {error}', file=sys.stderr)
            self.next_heartbeat = now + self.heartbeat_seconds
        if not ready:
            return 0
        if self.generation_lock is not None and not self.generation_lock.acquire():
            return 0
        processed = 0
        try:
            while processed < self.batch and process_one(self.client, self.llm, self.name):
                processed += 1
        finally:
            if self.generation_lock is not None:
                self.generation_lock.release()
        if processed:
            # Refresh the online marker right after work so the page reflects it.
            self.next_heartbeat = 0.0
        return processed
