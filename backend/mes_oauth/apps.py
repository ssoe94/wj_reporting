from django.apps import AppConfig


class MESOAuthConfig(AppConfig):
    name = 'mes_oauth'
    default_auto_field = 'django.db.models.BigAutoField'

    def ready(self):
        from . import signals  # noqa: F401
