from django.http import JsonResponse


def index(request):
    return JsonResponse({"message": "Overview module ready"}) 