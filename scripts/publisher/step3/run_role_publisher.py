import asyncio
import json
import os
import random
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any, Optional

from telethon import TelegramClient
from telethon.sessions import StringSession
from dotenv import load_dotenv
from supabase import create_client, Client


env_path = Path(__file__).resolve().parents[3] / ".env"
if env_path.exists():
    load_dotenv(env_path)

# Supabase 配置
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
SUPABASE_TABLE = os.environ.get("SUPABASE_TABLE", "role_data")

# Telegram 配置
ROLE_CHANNEL_URL = os.environ.get("ROLE_CHANNEL_URL", "")
API_ID = int(os.environ.get("TG_API_ID", "0"))
API_HASH = os.environ.get("TG_API_HASH", "")
SESSION_STRING = os.environ.get("TG_SESSION_STRING", "")

# 代理配置格式: PROXY = ('socks5', '127.0.0.1', 1080)
PROXY_RAW = os.environ.get("PROXY", "")
if PROXY_RAW:
    import ast
    try:
        proxy_tuple = ast.literal_eval(PROXY_RAW)
        if isinstance(proxy_tuple, tuple) and len(proxy_tuple) == 3:
            PROXY_TYPE = proxy_tuple[0]
            PROXY_HOST = proxy_tuple[1]
            PROXY_PORT = proxy_tuple[2]
        else:
            raise ValueError("PROXY format should be ('type', 'host', port)")
    except Exception as e:
        print(f"❌ 解析 PROXY 配置失败: {e}")
        PROXY_HOST = ""
        PROXY_PORT = None
        PROXY_TYPE = "socks5"
else:
    # 尝试读取 TELEGRAM_PROXY_ 前缀的变量
    PROXY_HOST = os.environ.get("TELEGRAM_PROXY_HOST", "")
    PROXY_PORT = int(os.environ.get("TELEGRAM_PROXY_PORT", "0")) or None
    PROXY_TYPE = os.environ.get("TELEGRAM_PROXY_SCHEME", "socks5")

CHECK_INTERVAL_MINUTES = float(os.environ.get("CHECK_INTERVAL_MINUTES", "15"))
PUBLISH_INTERVAL_SECONDS = int(os.environ.get("PUBLISH_INTERVAL_SECONDS", "30"))
RETRY_INTERVAL_MINUTES = float(os.environ.get("RETRY_INTERVAL_MINUTES", "5"))
DAILY_PUBLISH_AMOUNT = int(os.environ.get("DAILY_PUBLISH_AMOUNT", "0"))


def create_supabase_client() -> Client:
    """创建 Supabase 客户端"""
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise ValueError("Missing SUPABASE_URL or SUPABASE_KEY in environment variables")
    return create_client(SUPABASE_URL, SUPABASE_KEY)


def get_unpublished_roles(supabase: Client) -> List[Dict[str, Any]]:
    """从 Supabase 获取未发布的角色"""
    try:
        response = (
            supabase
            .table(SUPABASE_TABLE)
            .select("*")
            .is_("published_at", None)
            .execute()
        )
        roles = response.data or []
        unpublished_roles = [role for role in roles if not role.get("published_at")]
        if len(unpublished_roles) != len(roles):
            print(f"ℹ️ 过滤掉 {len(roles) - len(unpublished_roles)} 个已发布角色")
        print(f"📋 从 Supabase 获取到 {len(unpublished_roles)} 个未发布角色")
        return unpublished_roles
    except Exception as e:
        print(f"❌ 从 Supabase 获取角色失败: {e}")
        return []


def update_role_published_status(supabase: Client, role_id: int, post_link: str) -> bool:
    """更新角色的发布状态到 Supabase"""
    try:
        response = supabase.table(SUPABASE_TABLE).update({
            "published_at": datetime.now().isoformat(),
            "post_link": post_link
        }).eq("role_id", role_id).execute()
        
        if response.data:
            print(f"✅ 角色 ID {role_id} 状态更新成功")
            return True
        else:
            print(f"⚠️ 角色 ID {role_id} 状态更新失败：无数据返回")
            return False
    except Exception as e:
        print(f"❌ 更新角色 ID {role_id} 状态失败: {e}")
        return False


def should_publish_role(role: Dict[str, Any]) -> bool:
    """判断角色是否需要发布（从 Supabase 查询的角色已经是未发布的）"""
    return True


def is_direct_image_url(url: str) -> bool:
    """判断是否为直链图片"""
    return bool(url and url.startswith('http') and 't.me/' not in url)


async def resolve_avatar_to_direct_url(client: TelegramClient, avatar_url: str) -> Optional[str]:
    """
    将任何头像URL转换为直链
    - 直链 → 直接返回
    - 非直链（Telegram链接）→ 解析为CDN直链
    """
    if not avatar_url:
        return None
        
    if is_direct_image_url(avatar_url):
        # 情况2：已经是直链（Supabase等）
        return avatar_url
    
    # 情况1：非直链，解析Telegram链接
    import re
    match = re.search(r't\.me/c/(\d+)/(\d+)', avatar_url)
    if not match:
        return None
        
    try:
        channel_id, message_id = int(match.group(1)), int(match.group(2))
        # Telegram 私有频道 ID 需要转换为负数
        channel_id = -1000000000000 - channel_id
        message = await client.get_messages(channel_id, ids=message_id)
        
        if message and message.media:
            # file=None → 只返回CDN URL，不下载
            cdn_url = await client.download_media(message.media, file=None)
            print(f"📸 解析头像CDN直链: {cdn_url}")
            return cdn_url
    except Exception as e:
        print(f"⚠️ 解析Telegram头像失败: {e}")
    
    return None


def build_caption(role: Dict[str, Any]) -> str:
    # 映射调整: 使用 title 替代 name
    name = role.get("title") or role.get("name", "角色")
    summary = role.get("summary", "")
    tags = role.get("tags", [])
    deeplink = role.get("deeplink", "")
    tag_line = " ".join([f"#{t}" for t in tags])
    caption = (
        f"#{name}\n\n"
        f"{summary}\n\n"
        f"[🍬 启动蜜镜AI]({deeplink})\n\n"
        f"{tag_line}"
    )
    return caption


async def publish_role(client: TelegramClient, channel: str, role: Dict[str, Any], supabase: Client) -> bool:
    """发布单个角色并更新数据"""
    try:
        caption = build_caption(role)
        avatar_url = role.get('avatar')
        
        # 统一转换为直链
        direct_url = await resolve_avatar_to_direct_url(client, avatar_url)
        
        if direct_url:
            # 发送带图片的消息
            message = await client.send_file(channel, direct_url, caption=caption, parse_mode='md')
            print(f"📸 使用图片发布: {role.get('title', '未知')}")
        else:
            # 降级为纯文本
            message = await client.send_message(channel, caption, parse_mode='md')
            print(f"📝 降级为纯文本发布: {role.get('title', '未知')}")
        
        # 更新角色数据到 Supabase
        channel_username = channel.lstrip('@')
        post_link = f"https://t.me/{channel_username}/{message.id}"
        role_id = role.get('role_id')
        
        update_success = False
        if role_id and update_role_published_status(supabase, role_id, post_link):
            print(f"✅ 发布角色 '{role.get('title', '未知')}' 完成，post_link: {post_link}")
            update_success = True
        else:
            print(f"⚠️ 角色 '{role.get('title', '未知')}' 发布成功但状态更新失败")
        
        return update_success
    except Exception as e:
        print(f"❌ 发布角色 '{role.get('title', '未知')}' 失败: {e}")
        return False


def parse_channel_username(url_or_username: str) -> str:
    s = (url_or_username or "").strip()
    if not s:
        raise ValueError("ROLE_CHANNEL_URL is empty. Please set https://t.me/<username> in .env")
    if s.startswith("@"):  # already username
        return s
    prefixes = [
        "https://t.me/",
        "http://t.me/",
        "https://telegram.me/",
        "http://telegram.me/",
        "t.me/",
        "telegram.me/",
    ]
    for p in prefixes:
        if s.startswith(p):
            s = s[len(p):]
            break
    first = s.split("/")[0]
    if not first:
        raise ValueError("ROLE_CHANNEL_URL invalid")
    if first == "c" or first.startswith("+"):
        raise ValueError("Private/invite links not supported. Use public username URL like https://t.me/ai_role_list")
    return "@" + first

async def publish_unpublished_roles(
    client: TelegramClient,
    channel: str,
    roles: List[Dict[str, Any]],
    supabase: Client,
    daily_limit: Optional[int] = None,
) -> int:
    """发布未发布的角色，返回成功发布数量"""
    if not roles:
        print("✅ 没有未发布的角色")
        return 0
    
    print(f"📋 准备发布 {len(roles)} 个角色")
    published_count = 0
    
    for index, role in enumerate(roles, 1):
        if daily_limit is not None and published_count >= daily_limit:
            break
        
        success = await publish_role(client, channel, role, supabase)
        if success:
            published_count += 1
            if daily_limit:
                print(f"🎯 今日进度: {published_count}/{daily_limit}")
        
        if daily_limit is not None and published_count >= daily_limit:
            break
        
        if index < len(roles) and (daily_limit is None or published_count < daily_limit):
            await asyncio.sleep(PUBLISH_INTERVAL_SECONDS)
    
    print(f"✅ 本轮成功发布 {published_count} 个角色")
    return published_count

def seconds_until_next_run(target_hour: int = 9, target_minute: int = 30) -> float:
    """返回距下一次本地时间目标点的秒数（默认 09:30）"""
    now = datetime.now()
    today_target = now.replace(
        hour=target_hour,
        minute=target_minute,
        second=0,
        microsecond=0,
    )
    if now < today_target:
        next_run = today_target
    else:
        next_run = today_target + timedelta(days=1)
    return (next_run - now).total_seconds()

async def run_daily_publish(
    client: TelegramClient,
    channel: str,
    supabase: Client,
) -> None:
    daily_limit = DAILY_PUBLISH_AMOUNT if DAILY_PUBLISH_AMOUNT > 0 else None
    if daily_limit:
        print(f"🎯 启动每日限额模式：目标发布 {daily_limit} 个角色")
    else:
        print("ℹ️ DAILY_PUBLISH_AMOUNT 未配置或 <= 0，将发布所有未发布角色后退出")

    roles = get_unpublished_roles(supabase)
    published_count = await publish_unpublished_roles(
        client,
        channel,
        roles,
        supabase,
        daily_limit=daily_limit,
    )
    
    if daily_limit and published_count >= daily_limit:
        print(f"🏁 今日发布数量已达到 {daily_limit}，本轮结束")
    else:
        print("🏁 本轮未发布角色已处理完毕或无可发布角色")

async def main() -> None:
    assert API_ID and API_HASH and SESSION_STRING, "Missing TG_API_ID/TG_API_HASH/TG_SESSION_STRING"
    channel = parse_channel_username(ROLE_CHANNEL_URL)
    
    # 初始化 Supabase 客户端
    supabase = create_supabase_client()

    # 配置代理（如果设置了）
    proxy = None
    if PROXY_HOST and PROXY_PORT:
        import socks
        if PROXY_TYPE.lower() == "socks5":
            proxy = (socks.SOCKS5, PROXY_HOST, PROXY_PORT)
        elif PROXY_TYPE.lower() == "socks4":
            proxy = (socks.SOCKS4, PROXY_HOST, PROXY_PORT)
        elif PROXY_TYPE.lower() == "http":
            proxy = (socks.HTTP, PROXY_HOST, PROXY_PORT)
        else:
            raise ValueError(f"Unsupported proxy type: {PROXY_TYPE}")
        print(f"Using {PROXY_TYPE} proxy: {PROXY_HOST}:{PROXY_PORT}")
    
    client = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH, proxy=proxy)
    async with client:
        print("🚀 角色发布脚本启动")

        while True:
            try:
                wait_seconds = seconds_until_next_run(9, 30)
                next_run_time = datetime.now() + timedelta(seconds=wait_seconds)
                print(f"⏰ 下次自动发布: {next_run_time.strftime('%Y-%m-%d %H:%M:%S')}（本地时间）")
                await asyncio.sleep(wait_seconds)

                await run_daily_publish(client, channel, supabase)
            except Exception as e:
                print(f"❌ 每日发布任务出错: {e}")
                print(f"⏰ 等待 {RETRY_INTERVAL_MINUTES} 分钟后重试...")
                await asyncio.sleep(RETRY_INTERVAL_MINUTES * 60)

if __name__ == "__main__":
    asyncio.run(main())
