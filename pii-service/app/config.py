"""Configuration, read once from the environment: PII_MODEL and SERVICES_API_KEY."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    pii_model: str = "betterdataai/PII_DETECTION_MODEL"
    # Empty means no auth required.
    services_api_key: str = ""

    model_config = SettingsConfigDict(extra="ignore")


settings = Settings()
