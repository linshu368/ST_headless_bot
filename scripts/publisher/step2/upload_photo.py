import os
import time
from supabase import create_client, Client
from dotenv import load_dotenv

# 加载环境变量
# 假设 .env 文件位于项目根目录 (SillyTavern/.env)
# 脚本位于 SillyTavern/scripts/publisher/step2/upload_photo.py
# 需要向上回溯 3 级目录
env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), '.env')
load_dotenv(env_path)

# Supabase配置
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("❌ 未找到环境变量：请确保 .env 文件中已设置 SUPABASE_URL 和 SUPABASE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# 图片文件夹路径 - 使用相对路径
image_folder_path = os.path.join(os.path.dirname(__file__), "images_0313")

# 获取文件夹中的所有图片文件
image_files = [f for f in os.listdir(image_folder_path) if f.endswith(".png")]
print(f"📁 找到 {len(image_files)} 个图片文件")

# 统计变量
success_count = 0
failed_count = 0
db_update_success = 0
db_update_failed = 0

# 上传图片到Supabase存储桶并获取公开URL
for i, image_file in enumerate(image_files, 1):
    print(f"\n📋 处理进度: {i}/{len(image_files)} - {image_file}")
    role_id = image_file.split("_")[1]  # 从文件名中提取role_id（例如 role_1_avatar.png -> 1）
    file_path = os.path.join(image_folder_path, image_file)

    # 上传图片
    with open(file_path, "rb") as file:
        upload_success = False
        try:
            # 尝试上传图片
            try:
                response = supabase.storage.from_("avatar").upload(image_file, file)
                print(f"✅ 上传成功: {image_file}")
                upload_success = True
                success_count += 1
            except Exception as upload_error:
                # 如果是重复文件错误，先删除再重新上传
                if "already exists" in str(upload_error) or "Duplicate" in str(upload_error):
                    print(f"🔄 文件已存在，正在覆盖: {image_file}")
                    supabase.storage.from_("avatar").remove([image_file])
                    file.seek(0)  # 重置文件指针
                    response = supabase.storage.from_("avatar").upload(image_file, file)
                    print(f"✅ 覆盖上传成功: {image_file}")
                    upload_success = True
                    success_count += 1
                else:
                    raise upload_error

            # 获取图片的公开URL
            public_url = supabase.storage.from_("avatar").get_public_url(image_file)
            print(f"🔗 图片的公开URL: {public_url}")

            # 更新role_data表的avatar字段 - 添加重试机制
            avatar_url = public_url
            max_retries = 3
            db_updated = False
            
            for attempt in range(max_retries):
                try:
                    update_response = supabase.from_("role_data").update({"avatar": avatar_url}).eq("role_id", int(role_id)).execute()
                    print(f"✅ 角色ID {role_id} 的头像URL已更新成功")
                    db_updated = True
                    db_update_success += 1
                    break
                except Exception as db_error:
                    if attempt < max_retries - 1:
                        print(f"⚠️  数据库更新失败 (尝试 {attempt + 1}/{max_retries}): {str(db_error)}")
                        time.sleep(2)  # 等待2秒后重试
                    else:
                        print(f"❌ 数据库更新最终失败 (角色ID {role_id}): {str(db_error)}")
                        db_update_failed += 1

        except Exception as e:
            print(f"❌ 处理 {image_file} 时出错: {str(e)}")
            failed_count += 1

# 最终统计报告
print(f"\n" + "="*50)
print(f"📊 最终处理报告")
print(f"="*50)
print(f"📁 总文件数: {len(image_files)}")
print(f"✅ 上传成功: {success_count}")
print(f"❌ 上传失败: {failed_count}")
print(f"🔄 数据库更新成功: {db_update_success}")
print(f"⚠️  数据库更新失败: {db_update_failed}")
print(f"📈 上传成功率: {success_count/len(image_files)*100:.1f}%")
print(f"📈 数据库更新成功率: {db_update_success/(db_update_success+db_update_failed)*100:.1f}%" if (db_update_success+db_update_failed) > 0 else "📈 数据库更新成功率: 0%")
print(f"="*50)
