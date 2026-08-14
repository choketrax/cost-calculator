"""Pytest configuration for the AI Cost Auditor test suite."""
import pytest


# Use asyncio as the backend for anyio tests
pytest_plugins = ("anyio",)
