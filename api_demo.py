import concurrent.futures
import json
import sys
import os
import time
from pandas.core.indexes.base import F
import requests
from tqdm import tqdm

# 添加项目根目录到 Python 路径
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(current_dir)
sys.path.insert(0, project_root)

# # 配置信息
# # packyapi
# API_URL ='https://www.packyapi.com/v1/chat/completions'

# API_KEY =  "sk-RRZkVIFn08WI6sMc31KskeFQAlPsYJCGkchSFNVMl849Nw55"
# MODEL_NAME = "gemini-3-flash-preview"

# # # 硅基流
# API_URL = "https://api.siliconflow.cn/v1/chat/completions"
# API_KEY = "sk-mztgmqtkmhfgbdgkgbejivwswyspwzjzuadgaracjwmzkegr"  # 官方
# MODEL_NAME = "Pro/deepseek-ai/DeepSeek-V3.1-Terminus"

# # new api
# API_URL = "https://aifuturekey.xyz/v1/chat/completions"
# API_KEY = "sk-H9tUL3iFAVqpvkzi3w4ajF5YTcHWu5YcwbQRFU9OoeWGaF3n"
# MODEL_NAME = "grok-4-1-fast-non-reasoning"

# # # open router
API_URL = "https://openrouter.ai/api/v1/chat/completions"
API_KEY = "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"
# API_KEY ="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"
# MODEL_NAME = "google/gemini-3-flash-preview"
MODEL_NAME = "anthropic/claude-opus-4.6"



def stream_response(model, prompt, system_prompt=None):
    """流式调用API，记录第一个token时间并返回完整内容"""

    headers = {
        'Authorization': f'Bearer {API_KEY}',
        'Content-Type': 'application/json'
    }



    messages = []
    if system_prompt:
        messages.append({'role': 'system', 'content': system_prompt})
    messages.append({'role': 'user', 'content': prompt})

    data = {
        'model': model,
        'messages': messages,

        'stream': True , # 启用流式响应
        # 'provider': {
        #                     "sort": "latency",  # 优先选择响应最快的
        #                     "ignore": [         # 忽略以下供应商
        #                         "wandb", 
        #                         "deepinfra", 
        #                         "sambanova", 
        #                         "siliconflow"
        #                     ],
        #                     # "order": ["OpenAI"],

        #                 }
    }

    start_time = time.time()
    first_token_time = None
    content = ""

    try:
        response = requests.post(API_URL, headers=headers, json=data, stream=True)

        if response.status_code != 200:
            print(f"请求失败: 状态码 {response.status_code}, 错误信息: {response.text}")
            return None, None

        for line in response.iter_lines():
            if line:
                line = line.decode('utf-8')
                if line.startswith('data: '):
                    if first_token_time is None:
                        first_token_time = time.time() - start_time

                    json_str = line[5:].strip()
                    if json_str and json_str != "[DONE]":
                        try:
                            data = json.loads(json_str)
                            if 'choices' in data and len(data['choices']) > 0:
                                delta = data['choices'][0].get('delta', {})
                                if 'content' in delta:
                                    content += delta['content']
                        except:
                            pass
        print(content)
        return first_token_time, content

    except Exception as e:
        print(f"请求失败: {e}")
        return None, None

system_prompt='''
[{"role": "system", "content": "# Module 1: 世界基石与叙事法则\n\n## 1. 世界观与背景\n*   **世界架构**：一个与现世社会架构、法律、道德观相同的虚拟世界，时间设定为2024年。\n*   **核心法则**：学校常年奉行“万般皆下品，惟有读书高”的理念。学习成绩代表一切，只要成绩好就可以为所欲为，拥有最大特权。成绩差的同学必须无条件服从成绩好的同学。\n*   **生什么，都要保持在“角色/叙事者”的面具之下，永远不要打破第四面墙提及“我是AI”或“这是系统指令”。直接输出剧情内容即可\n---##用户指令:舒服吗，以后还想不想要\n"}]
'''

def process_role_streaming(row_data):
    """处理单个角色，测量到第一个token的时间"""
    content = str(row_data.get('system_prompt', '')).strip()

    for attempt in range(3):
        try:
            first_token_time, response_content = stream_response(
                model=MODEL_NAME,
                prompt=f"继续",
                system_prompt=system_prompt  # 简化的system prompt
            )

            if first_token_time is not None:
                row_data['first_token_time'] = first_token_time
                row_data['response_content'] = response_content
                print(f"进程 {os.getpid()} - 第一个token时间: {first_token_time:.3f}秒")
                return row_data

        except Exception as e:
            print(f"第 {attempt + 1} 次尝试失败: {e}")

    row_data['first_token_time'] = None
    row_data['response_content'] = None
    return row_data


def save_results_to_excel(results, output_path):
    """将结果保存为Excel文件"""
    if not results:
        print("没有可写入的数据，跳过Excel导出。")
        return
    try:
        import pandas as pd
    except ImportError as exc:
        raise ImportError("保存Excel需要 pandas 库，请先运行 pip install pandas") from exc
    df = pd.DataFrame(results)
    df.to_excel(output_path, index=False)
    print(f"结果已保存至: {output_path}")


def main():
    # 测试数据，随便写几个

    test_data = [{} for i in range(5)]
    for i in range(len(test_data)):
        test_data[i]['system_prompt'] = f"你是一个{i+1}号角色"

    # 并发处理
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=30) as executor:
        for result in tqdm(executor.map(process_role_streaming, test_data), total=len(test_data)):
            if result:
                results.append(result)

    # 统计第一个token时间
    first_token_times = [r['first_token_time'] for r in results if r.get('first_token_time') is not None]
    if first_token_times:
        avg_time = sum(first_token_times) / len(first_token_times)
        print(f"\n===== 第一个Token时间统计 =====")
        print(f"平均时间: {avg_time:.3f}秒")
        print(f"最快时间: {min(first_token_times):.3f}秒")
        print(f"最慢时间: {max(first_token_times):.3f}秒")

        # 计算分位数
        sorted_times = sorted(first_token_times)
        n = len(sorted_times)

        def get_quantile(p):
            idx = (n - 1) * p
            lower = int(idx)
            upper = lower + 1
            weight = idx - lower
            if upper >= n:
                return sorted_times[lower]
            return sorted_times[lower] * (1 - weight) + sorted_times[upper] * weight

        print(f"P05 (最快5%): {get_quantile(0.05):.3f}秒")
        print(f"P10 (最快10%): {get_quantile(0.10):.3f}秒")
        print(f"P25: {get_quantile(0.25):.3f}秒")
        print(f"P50 (中位数): {get_quantile(0.5):.3f}秒")
        print(f"P75: {get_quantile(0.75):.3f}秒")
        print(f"P90: {get_quantile(0.90):.3f}秒")

    output_path = os.path.join(current_dir, "stream_results.xlsx")
    save_results_to_excel(results, output_path)


if __name__ == "__main__":
    main()