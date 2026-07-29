"""Concurrent one-shot camera captures must share a single connection.

Bambu firmware allows exactly ONE camera connection. Callers already avoid
competing with the fan-out broadcaster via ``is_stream_active`` (#1271, #1348),
but nothing coordinated the one-shot capturers with each other. Observed on a
live P2S: the Obico poll loop and the ``/camera/snapshot`` endpoint opened
separate RTSP sockets 207ms apart, producing an "RTSP read timeout" and a
stale fan-out stream that the janitor then killed.
"""

import asyncio
from unittest.mock import patch

import pytest

from backend.app.services import camera as camera_service


class TestCaptureSingleFlight:
    @pytest.mark.asyncio
    async def test_concurrent_captures_open_one_connection(self):
        """Five simultaneous callers must produce exactly one capture."""
        calls = 0

        async def slow_capture(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.05)
            return b"jpeg-bytes"

        with patch.object(camera_service, "_capture_camera_frame_bytes_uncoalesced", slow_capture):
            results = await asyncio.gather(
                *[camera_service.capture_camera_frame_bytes("10.0.2.43", "code", "P2S") for _ in range(5)]
            )

        assert calls == 1, f"expected one underlying capture, got {calls}"
        assert all(r == b"jpeg-bytes" for r in results)

    @pytest.mark.asyncio
    async def test_different_printers_are_not_coalesced(self):
        """Coalescing is per-printer — two printers have two camera slots."""
        seen = []

        async def capture(ip, *_args, **_kwargs):
            seen.append(ip)
            await asyncio.sleep(0.02)
            return b"x"

        with patch.object(camera_service, "_capture_camera_frame_bytes_uncoalesced", capture):
            await asyncio.gather(
                camera_service.capture_camera_frame_bytes("10.0.2.43", "c", "P2S"),
                camera_service.capture_camera_frame_bytes("10.0.2.44", "c", "P2S"),
            )

        assert sorted(seen) == ["10.0.2.43", "10.0.2.44"]

    @pytest.mark.asyncio
    async def test_sequential_captures_are_not_cached(self):
        """Coalescing must not turn into caching — a later poll gets a fresh frame."""
        calls = 0

        async def capture(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            return f"frame-{calls}".encode()

        with patch.object(camera_service, "_capture_camera_frame_bytes_uncoalesced", capture):
            first = await camera_service.capture_camera_frame_bytes("10.0.2.43", "c", "P2S")
            second = await camera_service.capture_camera_frame_bytes("10.0.2.43", "c", "P2S")

        assert first == b"frame-1"
        assert second == b"frame-2"
        assert calls == 2

    @pytest.mark.asyncio
    async def test_follower_survives_leader_failure(self):
        """A failed leader must not poison everyone waiting on it."""
        attempts = 0

        async def flaky(*_args, **_kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                await asyncio.sleep(0.02)
                raise RuntimeError("RTSP read timeout")
            return b"recovered"

        with patch.object(camera_service, "_capture_camera_frame_bytes_uncoalesced", flaky):
            leader = asyncio.create_task(camera_service.capture_camera_frame_bytes("10.0.2.43", "c", "P2S"))
            await asyncio.sleep(0.005)
            follower = asyncio.create_task(camera_service.capture_camera_frame_bytes("10.0.2.43", "c", "P2S"))

            with pytest.raises(RuntimeError):
                await leader
            assert await follower == b"recovered"

    @pytest.mark.asyncio
    async def test_registry_does_not_leak(self):
        """The in-flight entry must be cleared so later polls aren't blocked."""

        async def capture(*_args, **_kwargs):
            return b"x"

        with patch.object(camera_service, "_capture_camera_frame_bytes_uncoalesced", capture):
            await camera_service.capture_camera_frame_bytes("10.0.2.43", "c", "P2S")

        assert "10.0.2.43" not in camera_service._inflight_captures
