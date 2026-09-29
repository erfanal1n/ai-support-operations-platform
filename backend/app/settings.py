from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class OperatorCredential(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=120)
    role: Literal["agent", "supervisor"]
    token: str = Field(min_length=32)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    port: int = Field(default=3000, gt=0)
    host: str = "127.0.0.1"
    node_env: Literal["development", "test", "production"] = "development"
    auth_mode: Literal["disabled", "session"] = "disabled"
    session_secret: str | None = None
    support_operator_tokens: list[OperatorCredential] = Field(default_factory=list)
    storage_mode: Literal["memory", "postgres"] = "memory"
    database_url: str | None = None
    policy_retrieval_mode: Literal["keyword", "semantic"] = "keyword"
    ai_triage_mode: Literal["disabled", "openai"] = "disabled"
    openai_api_key: str | None = None
    openai_embedding_model: str = "text-embedding-3-small"
    openai_triage_model: str = "gpt-6-luna"
    redis_url: str | None = None
    log_level: Literal["critical", "error", "warning", "info", "debug"] = "info"

    @model_validator(mode="after")
    def check_runtime_requirements(self) -> Settings:
        if self.auth_mode == "session":
            if not self.session_secret or len(self.session_secret) < 32:
                raise ValueError("SESSION_SECRET must contain at least 32 characters")
            if not self.support_operator_tokens:
                raise ValueError(
                    "At least one operator token is required when session auth is enabled"
                )
            ids = [item.id for item in self.support_operator_tokens]
            tokens = [item.token for item in self.support_operator_tokens]
            if len(set(ids)) != len(ids) or len(set(tokens)) != len(tokens):
                raise ValueError("Operator IDs and tokens must be unique")
        if self.storage_mode == "postgres" and not self.database_url:
            raise ValueError("DATABASE_URL is required when PostgreSQL storage is enabled")
        if self.policy_retrieval_mode == "semantic" and not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required for semantic retrieval")
        if self.ai_triage_mode == "openai" and not self.openai_api_key:
            raise ValueError("OPENAI_API_KEY is required when AI triage is enabled")
        if self.node_env == "production":
            if self.auth_mode != "session":
                raise ValueError("Session authentication is required in production")
            if self.storage_mode != "postgres":
                raise ValueError("PostgreSQL storage is required in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()

