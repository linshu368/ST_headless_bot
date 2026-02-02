"""
Publisher模块 - 负责角色发布相关功能

该模块包含角色自动发布到Telegram频道的功能实现。
"""

from .run_role_publisher import (
    load_roles,
    save_roles,
    should_publish_role,
    build_caption,
    publish_role,
    parse_channel_username,
)

__all__ = [
    "load_roles",
    "save_roles", 
    "should_publish_role",
    "build_caption",
    "publish_role",
    "parse_channel_username",
]
