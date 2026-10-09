"""Existing APP supply, with one single-use identity client per broker lease.

Factories are trusted server dependencies, never HTTP inputs. No issuance,
refresh, counter reset or broker's implicit APP fallback is allowed here.
"""
from django.conf import settings
from django.views.decorators.debug import sensitive_variables

from .plan_workflow import WorkflowConflict


@sensitive_variables()
def existing_provider_factory(origin):
    from mes_oauth.app_tokens import get_existing_app_access_token
    from mes_oauth.client import BlacklakeUserOAuthClient
    app = get_existing_app_access_token()
    header = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token')

    @sensitive_variables()
    def create_provider():
        return BlacklakeUserOAuthClient(origin=origin, app_access_token=app,
            app_token_header=header)

    return create_provider


@sensitive_variables()
def provider_for_lease(factory):
    if not callable(factory):
        raise WorkflowConflict('existing_app_provider_required')
    provider = factory()
    if provider is None:
        # None would silently opt into the broker's normal issuance fallback.
        raise WorkflowConflict('existing_app_provider_required')
    return provider
