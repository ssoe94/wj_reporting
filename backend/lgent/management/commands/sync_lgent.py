import json
from django.core.management.base import BaseCommand
from lgent.continuous import run


class Command(BaseCommand):
    help='Read LG changes and compare private photo replicas for opted-in LG connections. Never writes to LG.'

    def add_arguments(self,parser):
        parser.add_argument('--seconds',type=int,default=240)

    def handle(self,*args,**options):
        seconds=options['seconds']
        if not 1<=seconds<=240:raise ValueError('Use a time budget between 1 and 240 seconds.')
        self.stdout.write(json.dumps(run(seconds)))
